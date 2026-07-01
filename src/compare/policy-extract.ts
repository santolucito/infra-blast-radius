// Tool-agnostic IAM policy extraction. Pulls IAM policy documents out of the
// inputs we can read statically (PLAN.md §7, P1):
//   - standalone IAM policy .json files
//   - CloudFormation templates (inline policies)
// Terraform inline jsonencode/data.aws_iam_policy_document needs HCL expression
// evaluation and is a documented follow-up (PLAN.md §8).

import * as fs from 'fs';
import * as path from 'path';
import { loadTemplate } from '../parsers/cloudformation';

export interface ExtractedPolicy {
  /** Stable identity used to diff the same policy across refs. */
  policyId: string;
  /** The IAM policy document (Version/Statement JSON). */
  document: unknown;
  sourceFile: string;
  /**
   * How many principals (roles/users/groups) carry this policy, from the CFN
   * attachment graph. Undefined for bare policy files (treated as 1 downstream).
   * A grant on a policy attached to N principals is reachable by all N.
   */
  principalCount?: number;
}

const CFN_EXTS = new Set(['.yaml', '.yml', '.json']);

function isPolicyDocument(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && 'Statement' in (v as Record<string, unknown>);
}

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
    else if (CFN_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

/** Resolve a CFN reference to a local logical id: {Ref:X} / {Fn::GetAtt:[X,..]} /
 * "X.Arn" string form; a plain string (literal name/arn) is returned as-is. */
function principalRef(item: unknown): string | null {
  if (typeof item === 'string') return item.includes('.') ? item.split('.')[0] : item;
  if (item && typeof item === 'object') {
    const o = item as Record<string, any>;
    if (typeof o.Ref === 'string') return o.Ref;
    const ga = o['Fn::GetAtt'];
    if (Array.isArray(ga) && typeof ga[0] === 'string') return ga[0];
    if (typeof ga === 'string') return ga.split('.')[0];
  }
  return null;
}

/** Count distinct principals attached to a managed/customer policy `logicalId`:
 * its own Roles/Users/Groups lists, plus any Role/User/Group whose
 * ManagedPolicyArns references it. */
function countManagedPrincipals(
  logicalId: string,
  resources: Record<string, any>
): number {
  const principals = new Set<string>();
  const self = resources[logicalId]?.Properties ?? {};
  for (const key of ['Roles', 'Users', 'Groups']) {
    const arr = self[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const id = principalRef(item);
        if (id) principals.add(id);
      }
    }
  }
  for (const [rid, rbody] of Object.entries(resources)) {
    if (!/^AWS::IAM::(Role|User|Group)$/.test(rbody?.Type ?? '')) continue;
    const arns = rbody?.Properties?.ManagedPolicyArns;
    if (Array.isArray(arns) && arns.some((a) => principalRef(a) === logicalId)) {
      principals.add(rid);
    }
  }
  return principals.size;
}

function extractFromCfn(doc: unknown, relFile: string, out: ExtractedPolicy[]): void {
  if (!doc || typeof doc !== 'object') return;
  const resources = (doc as Record<string, any>).Resources;
  if (!resources || typeof resources !== 'object') return;

  for (const [logicalId, body] of Object.entries(resources as Record<string, any>)) {
    if (!body || typeof body !== 'object') continue;
    const type: string = body.Type ?? '';
    const props = body.Properties ?? {};

    // AWS::IAM::Policy / ManagedPolicy -> Properties.PolicyDocument
    if (/^AWS::IAM::(Policy|ManagedPolicy)$/.test(type) && isPolicyDocument(props.PolicyDocument)) {
      out.push({
        policyId: `${relFile}#${logicalId}`,
        document: props.PolicyDocument,
        sourceFile: relFile,
        principalCount: countManagedPrincipals(logicalId, resources),
      });
    }

    // AWS::IAM::Role/User/Group -> Properties.Policies[].PolicyDocument (inline).
    // An inline policy is carried by exactly one principal (this resource).
    if (Array.isArray(props.Policies)) {
      props.Policies.forEach((p: any, i: number) => {
        if (isPolicyDocument(p?.PolicyDocument)) {
          const name = typeof p.PolicyName === 'string' ? p.PolicyName : String(i);
          out.push({
            policyId: `${relFile}#${logicalId}/${name}`,
            document: p.PolicyDocument,
            sourceFile: relFile,
            principalCount: 1,
          });
        }
      });
    }
  }
}

/**
 * Extract every IAM policy document under `rootDir` (optionally restricted to
 * `target`, a file or subdirectory). Paths in policyIds are relative to
 * `rootDir` so identities are stable across git-ref worktrees.
 */
export function extractPolicies(rootDir: string, target?: string): ExtractedPolicy[] {
  const base = target ? path.resolve(rootDir, target) : rootDir;
  const files: string[] = [];
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) walk(base, files);
  else if (CFN_EXTS.has(path.extname(base).toLowerCase())) files.push(base);

  const out: ExtractedPolicy[] = [];
  for (const file of files.sort()) {
    const rel = path.relative(rootDir, file) || path.basename(file);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let doc: unknown;
    try {
      doc = loadTemplate(raw);
    } catch {
      continue; // unparseable mid-edit / non-template file
    }
    if (isPolicyDocument(doc)) {
      // A bare IAM policy file.
      out.push({ policyId: rel, document: doc, sourceFile: rel });
    } else {
      extractFromCfn(doc, rel, out);
    }
  }
  return out;
}
