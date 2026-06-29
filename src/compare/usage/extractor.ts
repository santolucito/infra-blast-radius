// Static usage extractor: scan application code for AWS SDK calls and map them
// to the concrete IAM actions the code actually invokes (the "used" set).
//
// Pairs with the IAM analysis (the "granted" set / ceiling). The unnecessary
// blast radius is granted − used (see ./diff.ts). Grounding "too much access"
// in evidence from the code is the point: a policy granting s3:* whose code
// only calls s3:GetObject is carrying a large unnecessary radius.
//
// APPROACH — regex/heuristic, deliberately a prototype. We do NOT build an AST
// or resolve types. We rely on three reliable signals plus one conservative
// fallback:
//   1. aws-sdk v3 command classes: `new GetObjectCommand(...)`, including via
//      `client.send(new PutObjectCommand(...))`. Command class names are the
//      strongest signal and are mapped directly.
//   2. aws-sdk v2 service bindings: `const s3 = new AWS.S3()` /
//      `new S3(...)` / `new AWS.DynamoDB.DocumentClient()` bind a variable to a
//      service; then `s3.getObject(...)` resolves via the per-service method map.
//   3. aws-sdk v2 inline calls: `new AWS.S3().putObject(...)`.
//   4. Conservative generic fallback: a bare `x.getSecretValue(...)` whose
//      method name is in a curated DISTINCTIVE set and maps to exactly one
//      service. Limited to AWS-idiosyncratic names to avoid false positives on
//      ordinary code (e.g. `.query(`, `.publish(` are intentionally excluded).
//
// LIMITS (documented in INTEGRATION-grantused.md too):
//   - No data-flow: we cannot tell which bucket/ARN an action targets, only the
//     action verb. Resource-level least-privilege is out of scope here.
//   - Dynamic dispatch (`client[op](...)`), re-exported wrappers, and helper
//     libraries that call the SDK on your behalf are missed → under-counts USED.
//     Under-counting USED over-counts UNNECESSARY, i.e. the safe direction (we
//     never claim a grant is unnecessary when it might be used silently... we
//     can: a missed call would wrongly flag a grant as unnecessary — see note).
//   - Service/op coverage is limited to the table below (8 common services).

import * as fs from 'fs';
import * as path from 'path';

/** One mappable SDK operation for a service. */
interface OpDef {
  /** IAM action name without the service prefix, e.g. "GetObject". */
  action: string;
  /** aws-sdk v2 method names (camelCase). Defaults to camelCase(action). */
  methods?: string[];
  /** aws-sdk v3 command class names. Defaults to `${action}Command`. */
  commands?: string[];
}

// ── Service operation tables ────────────────────────────────────────────────
// Curated common operations per service. Extend as needed; this is a prototype
// surface, not the full AWS API. `action` is the canonical IAM action name.
const SERVICE_OPS: Record<string, OpDef[]> = {
  s3: [
    { action: 'GetObject', methods: ['getObject', 'headObject'], commands: ['GetObjectCommand', 'HeadObjectCommand'] },
    { action: 'PutObject', methods: ['putObject', 'upload'], commands: ['PutObjectCommand'] },
    { action: 'DeleteObject', methods: ['deleteObject'], commands: ['DeleteObjectCommand'] },
    { action: 'ListBucket', methods: ['listObjects', 'listObjectsV2', 'headBucket'], commands: ['ListObjectsCommand', 'ListObjectsV2Command', 'HeadBucketCommand'] },
    { action: 'GetBucketPolicy', methods: ['getBucketPolicy'], commands: ['GetBucketPolicyCommand'] },
    { action: 'PutBucketPolicy', methods: ['putBucketPolicy'], commands: ['PutBucketPolicyCommand'] },
    { action: 'CreateBucket', methods: ['createBucket'], commands: ['CreateBucketCommand'] },
    { action: 'DeleteBucket', methods: ['deleteBucket'], commands: ['DeleteBucketCommand'] },
    { action: 'ListAllMyBuckets', methods: ['listBuckets'], commands: ['ListBucketsCommand'] },
  ],
  secretsmanager: [
    { action: 'GetSecretValue', methods: ['getSecretValue'], commands: ['GetSecretValueCommand'] },
    { action: 'PutSecretValue', methods: ['putSecretValue'], commands: ['PutSecretValueCommand'] },
    { action: 'CreateSecret', methods: ['createSecret'], commands: ['CreateSecretCommand'] },
    { action: 'DeleteSecret', methods: ['deleteSecret'], commands: ['DeleteSecretCommand'] },
    { action: 'DescribeSecret', methods: ['describeSecret'], commands: ['DescribeSecretCommand'] },
    { action: 'ListSecrets', methods: ['listSecrets'], commands: ['ListSecretsCommand'] },
    { action: 'UpdateSecret', methods: ['updateSecret'], commands: ['UpdateSecretCommand'] },
  ],
  dynamodb: [
    // v2 low-level + v3 client-dynamodb commands, and the DocumentClient/
    // lib-dynamodb aliases (get/put/... and GetCommand/PutCommand/...).
    { action: 'GetItem', methods: ['getItem', 'get'], commands: ['GetItemCommand', 'GetCommand'] },
    { action: 'PutItem', methods: ['putItem', 'put'], commands: ['PutItemCommand', 'PutCommand'] },
    { action: 'DeleteItem', methods: ['deleteItem', 'delete'], commands: ['DeleteItemCommand', 'DeleteCommand'] },
    { action: 'UpdateItem', methods: ['updateItem', 'update'], commands: ['UpdateItemCommand', 'UpdateCommand'] },
    { action: 'Query', methods: ['query'], commands: ['QueryCommand'] },
    { action: 'Scan', methods: ['scan'], commands: ['ScanCommand'] },
    { action: 'BatchGetItem', methods: ['batchGetItem', 'batchGet'], commands: ['BatchGetItemCommand', 'BatchGetCommand'] },
    { action: 'BatchWriteItem', methods: ['batchWriteItem', 'batchWrite'], commands: ['BatchWriteItemCommand', 'BatchWriteCommand'] },
    { action: 'DescribeTable', methods: ['describeTable'], commands: ['DescribeTableCommand'] },
  ],
  sns: [
    { action: 'Publish', methods: ['publish'], commands: ['PublishCommand'] },
    { action: 'Subscribe', methods: ['subscribe'], commands: ['SubscribeCommand'] },
    { action: 'CreateTopic', methods: ['createTopic'], commands: ['CreateTopicCommand'] },
    { action: 'DeleteTopic', methods: ['deleteTopic'], commands: ['DeleteTopicCommand'] },
    { action: 'ListTopics', methods: ['listTopics'], commands: ['ListTopicsCommand'] },
  ],
  sqs: [
    { action: 'SendMessage', methods: ['sendMessage', 'sendMessageBatch'], commands: ['SendMessageCommand', 'SendMessageBatchCommand'] },
    { action: 'ReceiveMessage', methods: ['receiveMessage'], commands: ['ReceiveMessageCommand'] },
    { action: 'DeleteMessage', methods: ['deleteMessage'], commands: ['DeleteMessageCommand'] },
    { action: 'GetQueueUrl', methods: ['getQueueUrl'], commands: ['GetQueueUrlCommand'] },
    { action: 'CreateQueue', methods: ['createQueue'], commands: ['CreateQueueCommand'] },
    { action: 'DeleteQueue', methods: ['deleteQueue'], commands: ['DeleteQueueCommand'] },
    { action: 'ListQueues', methods: ['listQueues'], commands: ['ListQueuesCommand'] },
  ],
  ssm: [
    { action: 'GetParameter', methods: ['getParameter'], commands: ['GetParameterCommand'] },
    { action: 'GetParameters', methods: ['getParameters'], commands: ['GetParametersCommand'] },
    { action: 'GetParametersByPath', methods: ['getParametersByPath'], commands: ['GetParametersByPathCommand'] },
    { action: 'PutParameter', methods: ['putParameter'], commands: ['PutParameterCommand'] },
    { action: 'DeleteParameter', methods: ['deleteParameter'], commands: ['DeleteParameterCommand'] },
    { action: 'DescribeParameters', methods: ['describeParameters'], commands: ['DescribeParametersCommand'] },
  ],
  lambda: [
    { action: 'InvokeFunction', methods: ['invoke', 'invokeAsync'], commands: ['InvokeCommand', 'InvokeAsyncCommand'] },
    { action: 'GetFunction', methods: ['getFunction'], commands: ['GetFunctionCommand'] },
    { action: 'ListFunctions', methods: ['listFunctions'], commands: ['ListFunctionsCommand'] },
    { action: 'CreateFunction', methods: ['createFunction'], commands: ['CreateFunctionCommand'] },
  ],
  kms: [
    { action: 'Decrypt', methods: ['decrypt'], commands: ['DecryptCommand'] },
    { action: 'Encrypt', methods: ['encrypt'], commands: ['EncryptCommand'] },
    { action: 'GenerateDataKey', methods: ['generateDataKey'], commands: ['GenerateDataKeyCommand'] },
    { action: 'GenerateDataKeyWithoutPlaintext', methods: ['generateDataKeyWithoutPlaintext'], commands: ['GenerateDataKeyWithoutPlaintextCommand'] },
    { action: 'DescribeKey', methods: ['describeKey'], commands: ['DescribeKeyCommand'] },
    { action: 'CreateKey', methods: ['createKey'], commands: ['CreateKeyCommand'] },
    { action: 'ListKeys', methods: ['listKeys'], commands: ['ListKeysCommand'] },
  ],
};

/** Map an aws-sdk v2 service class name (`new AWS.S3()`) to our service key. */
const SERVICE_CLASS: Record<string, string> = {
  S3: 's3',
  SecretsManager: 'secretsmanager',
  DynamoDB: 'dynamodb',
  SNS: 'sns',
  SQS: 'sqs',
  SSM: 'ssm',
  Lambda: 'lambda',
  KMS: 'kms',
};

const camel = (action: string) => action.charAt(0).toLowerCase() + action.slice(1);

// ── Derived indices (built once) ────────────────────────────────────────────
/** `${service}.${methodLower}` -> `service:Action` (v2 bound-variable calls). */
const serviceMethodIndex = new Map<string, string>();
/** command class name -> Set<`service:Action`> (v3). */
const commandIndex = new Map<string, Set<string>>();
/** methodLower -> Set<`service:Action`> (for the conservative fallback). */
const methodIndex = new Map<string, Set<string>>();

function add(map: Map<string, Set<string>>, key: string, val: string) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(val);
}

for (const [service, ops] of Object.entries(SERVICE_OPS)) {
  for (const op of ops) {
    const full = `${service}:${op.action}`;
    const methods = op.methods ?? [camel(op.action)];
    const commands = op.commands ?? [`${op.action}Command`];
    for (const m of methods) {
      serviceMethodIndex.set(`${service}.${m.toLowerCase()}`, full);
      add(methodIndex, m.toLowerCase(), full);
    }
    for (const c of commands) add(commandIndex, c, full);
  }
}

// Method names distinctive enough that a bare `x.method(` is almost certainly an
// AWS SDK call (used by the conservative generic fallback). Deliberately omits
// collision-prone verbs like query/scan/get/put/publish/subscribe/invoke.
const DISTINCTIVE_METHODS = new Set(
  [
    'getSecretValue', 'putSecretValue', 'describeSecret',
    'getParametersByPath', 'getParameter', 'putParameter',
    'generateDataKey', 'generateDataKeyWithoutPlaintext',
    'getSignedUrl', 'getBucketPolicy', 'putBucketPolicy',
    'getQueueUrl', 'listObjectsV2',
  ].map((m) => m.toLowerCase()),
);

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (CODE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

/** A single detected SDK call, kept for explainability / the demo. */
export interface UsageHit {
  action: string; // `service:Action`
  file: string; // path relative to the scanned root
  via: 'v3-command' | 'v2-bound' | 'v2-inline' | 'fallback';
  snippet: string; // the matched text, trimmed
}

export interface UsageResult {
  /** Sorted, de-duplicated IAM action strings the code invokes. */
  actions: string[];
  /** All raw detections (may include duplicate actions across files). */
  hits: UsageHit[];
}

/** Strip // line and /* *​/ block comments so commented-out calls don't count. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Scan one source string; append detections to `hits`. */
function scanSource(src: string, relFile: string, hits: UsageHit[]): void {
  const code = stripComments(src);

  // 1) v3 command classes: `new XxxCommand(` (covers `.send(new XxxCommand(`).
  for (const m of code.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*Command)\s*\(/g)) {
    const set = commandIndex.get(m[1]);
    if (!set) continue;
    // A command class name is unique to one operation in our tables; emit all
    // (always size 1 here, but stay correct if a future alias collides).
    for (const action of set) hits.push({ action, file: relFile, via: 'v3-command', snippet: m[0] });
  }

  // 2) v2 service bindings → variable name ⇒ service.
  const varService = new Map<string, string>();
  //   const s3 = new AWS.S3(...) | new S3(...)
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:AWS\.)?([A-Z][A-Za-z0-9]*)\s*\(/g)) {
    const svc = SERVICE_CLASS[m[2]];
    if (svc) varService.set(m[1], svc);
  }
  //   const ddb = new AWS.DynamoDB.DocumentClient(...)  → dynamodb
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:AWS\.)?DynamoDB\.DocumentClient\s*\(/g)) {
    varService.set(m[1], 'dynamodb');
  }

  //   bound-variable calls: `s3.getObject(` for each known var.
  for (const [varName, svc] of varService) {
    const re = new RegExp(`\\b${varName}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    for (const m of code.matchAll(re)) {
      const action = serviceMethodIndex.get(`${svc}.${m[1].toLowerCase()}`);
      if (action) hits.push({ action, file: relFile, via: 'v2-bound', snippet: m[0] });
    }
  }

  // 3) v2 inline: `new AWS.S3().getObject(`
  for (const m of code.matchAll(/new\s+(?:AWS\.)?([A-Z][A-Za-z0-9]*)\s*\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const svc = SERVICE_CLASS[m[1]];
    if (!svc) continue;
    const action = serviceMethodIndex.get(`${svc}.${m[2].toLowerCase()}`);
    if (action) hits.push({ action, file: relFile, via: 'v2-inline', snippet: m[0] });
  }

  // 4) Conservative fallback: `x.getSecretValue(` for distinctive, unambiguous
  //    method names only (avoids false positives on ordinary code).
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const ml = m[1].toLowerCase();
    if (!DISTINCTIVE_METHODS.has(ml)) continue;
    const set = methodIndex.get(ml);
    if (!set || set.size !== 1) continue; // only when unambiguous
    const action = [...set][0];
    hits.push({ action, file: relFile, via: 'fallback', snippet: `.${m[1]}(` });
  }
}

/**
 * Scan `codeDir` recursively and return the IAM actions the code invokes.
 * Returns both the sorted unique action list and the raw hits (for explaining
 * *where* each action came from).
 */
export function extractUsage(codeDir: string): UsageResult {
  const files: string[] = [];
  if (fs.existsSync(codeDir) && fs.statSync(codeDir).isDirectory()) walk(codeDir, files);
  else if (CODE_EXTS.has(path.extname(codeDir).toLowerCase())) files.push(codeDir);

  const hits: UsageHit[] = [];
  for (const file of files.sort()) {
    let src: string;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanSource(src, path.relative(codeDir, file) || path.basename(file), hits);
  }

  const actions = new Set<string>();
  for (const h of hits) actions.add(h.action);
  return { actions: [...actions].sort(), hits };
}

/** Convenience: just the sorted Set of IAM action strings the code uses. */
export function extractUsedActions(codeDir: string): Set<string> {
  return new Set(extractUsage(codeDir).actions);
}
