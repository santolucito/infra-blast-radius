// Feedback edge ① — reachability → IAM weight (docs/feedback-loops.md).
//
// The analyzers run in parallel and normally we just sum their findings. This
// module is the first *feedback line*: a Checkov `public_exposure` verdict on a
// resource sharpens cloudsplaining's IAM findings whose actions target that same
// resource. A broad grant on a private bucket is a latent risk; the same grant on
// a publicly-reachable bucket is a live exfiltration/tamper path — and neither
// tool sees that alone.
//
// The hard part is *resource identity across tools*: Checkov names a bucket
// `aws_s3_bucket.lake` (a Terraform logical id) while an IAM policy names it
// `arn:aws:s3:::pipeline-lake/*` (an ARN). We resolve that join for S3 and treat
// the resolver as the extensible seam a general blackboard would generalize.
//
// Direction of safety: unknown / unresolved identity yields no amplification, so
// this pass only ever *raises* the score of a grant we can prove reaches a public
// resource — it never lowers one.

import * as fs from 'fs';
import * as path from 'path';
import { ExtractedPolicy } from './policy-extract';
import { Finding } from './types';

/** A write/read grant on a publicly-reachable resource is this many times worse
 * than the same grant on a private one. Modest and tunable; drives ranking, not a
 * hard gate (mirrors UNUSED_MULTIPLIER's posture). */
export const EXPOSURE_MULTIPLIER = 3;

/** Normalized cross-tool resource identity, e.g. "s3:pipeline-lake". "*" means
 * "every resource" (an unconstrained grant), which reaches any public resource. */
export type ResourceToken = string;

// --- resource-identity resolver (prototype: scoped to S3) ---------------------

/** Map each `aws_s3_bucket` logical name to its real bucket name from Terraform
 * source (`bucket = "…"`), falling back to the logical name when absent. This is
 * the prototype-grade seam; a general blackboard would own this resolution. */
export function bucketNamesFromTf(tf: string): Map<string, string> {
  const map = new Map<string, string>();
  const block = /resource\s+"aws_s3_bucket"\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(tf))) {
    const named = /\bbucket\s*=\s*"([^"]+)"/.exec(m[2]);
    map.set(m[1], named ? named[1] : m[1]);
  }
  return map;
}

/** Normalize an IAM Resource entry to a token. Returns null for services we don't
 * resolve yet (only S3 in the prototype), so they simply don't amplify. */
export function arnToToken(resource: string): ResourceToken | null {
  if (resource === '*') return '*';
  const s3 = /^arn:aws:s3:::([^/]+)/.exec(resource);
  if (s3) return `s3:${s3[1]}`;
  return null;
}

/** Tokens for the resources Checkov flagged publicly reachable. A public_exposure
 * finding's subject is `<file>:<resource>` with resource `aws_s3_bucket.<logical>`. */
export function publicResourceTokens(
  findings: Finding[],
  buckets: Map<string, string>
): Set<ResourceToken> {
  const out = new Set<ResourceToken>();
  for (const f of findings) {
    if (f.channel !== 'network' || f.category !== 'public_exposure') continue;
    const resource = f.subject.split(':').pop() ?? '';
    const logical = /^aws_s3_bucket\.(.+)$/.exec(resource);
    if (!logical) continue; // non-S3 public exposure: not resolved in the prototype
    out.add(`s3:${buckets.get(logical[1]) ?? logical[1]}`);
  }
  return out;
}

// --- IAM finding → target resources -------------------------------------------

function statements(doc: unknown): Array<Record<string, any>> {
  const s = (doc as any)?.Statement;
  if (Array.isArray(s)) return s;
  return s ? [s] : [];
}

function asArray(x: unknown): string[] {
  if (Array.isArray(x)) return x as string[];
  return x != null ? [String(x)] : [];
}

/** Does a granted action pattern (`s3:*`, `s3:Get*`, `*`, exact) cover `action`? */
function actionCovers(granted: string, action: string): boolean {
  if (granted === '*') return true;
  if (granted.endsWith(':*')) return action.split(':')[0] === granted.slice(0, -2);
  if (granted.includes('*')) {
    const re = new RegExp(
      '^' + granted.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    );
    return re.test(action);
  }
  return granted.toLowerCase() === action.toLowerCase();
}

/** The resource tokens an IAM finding's action can touch, by matching the action
 * back to the statements that grant it and reading their Resource ARNs. A
 * service_wildcard finding (`detail` = service) matches whole-service grants. */
export function targetTokensForFinding(
  f: Finding,
  policyById: Map<string, ExtractedPolicy>
): Set<ResourceToken> {
  const out = new Set<ResourceToken>();
  if (f.channel !== 'iam') return out;
  const policy = policyById.get(f.subject);
  if (!policy) return out;

  for (const st of statements(policy.document)) {
    if ((st.Effect ?? 'Allow') !== 'Allow') continue;
    const granted = asArray(st.Action);
    const applies =
      f.category === 'service_wildcard'
        ? granted.some((a) => a === '*' || a.split(':')[0] === f.detail)
        : granted.some((a) => actionCovers(a, f.detail));
    if (!applies) continue;
    for (const r of asArray(st.Resource)) {
      const t = arnToToken(r);
      if (t) out.add(t);
    }
  }
  return out;
}

// --- the feedback pass --------------------------------------------------------

/** Pure core: tag each IAM finding that reaches a public resource with
 * `exposureFactor`. A finding reaches a public resource if it targets that
 * resource, or targets `*` (every resource, which includes the public ones). */
export function applyReachabilityFeedbackPure(
  findings: Finding[],
  policyById: Map<string, ExtractedPolicy>,
  publicTokens: Set<ResourceToken>,
  factor: number = EXPOSURE_MULTIPLIER
): Finding[] {
  if (publicTokens.size === 0) return findings;
  return findings.map((f) => {
    if (f.channel !== 'iam') return f;
    const targets = targetTokensForFinding(f, policyById);
    const reachesPublic =
      targets.has('*') || [...targets].some((t) => publicTokens.has(t));
    return reachesPublic ? { ...f, exposureFactor: factor } : f;
  });
}

function walkTf(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTf(full, out);
    else if (e.name.endsWith('.tf')) out.push(full);
  }
  return out;
}

/** I/O wrapper: read the worktree's Terraform to resolve bucket identity, collect
 * the public resources Checkov found, and amplify the IAM findings that reach
 * them. No-op unless there is at least one public resource. */
export function applyReachabilityFeedback(
  findings: Finding[],
  policies: ExtractedPolicy[],
  rootDir: string
): Finding[] {
  const buckets = new Map<string, string>();
  for (const file of walkTf(rootDir)) {
    try {
      for (const [k, v] of bucketNamesFromTf(fs.readFileSync(file, 'utf8'))) buckets.set(k, v);
    } catch {
      /* unreadable mid-edit — skip */
    }
  }
  const publicTokens = publicResourceTokens(findings, buckets);
  if (publicTokens.size === 0) return findings;
  const byId = new Map(policies.map((p) => [p.policyId, p]));
  return applyReachabilityFeedbackPure(findings, byId, publicTokens);
}
