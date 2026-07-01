// Normalize Checkov output into the common Finding model. This is the tested
// boundary where Checkov's vocabulary (check_ids on the `network`/misconfig
// channel) becomes ours — mirrors normalize.ts for Cloudsplaining.
//
// The categories Checkov contributes (network_exposure / public_exposure /
// encryption / misconfiguration) now live in src/compare/types.ts::RiskCategory
// with weights in DEFAULT_WEIGHTS, so this module emits plain Findings.

import { Finding, RiskCategory } from './types';

export const CHECKOV_SOURCE = 'checkov';

/** The RiskCategory subset Checkov maps onto (all members of RiskCategory). */
export type CheckovCategory =
  | 'network_exposure' // SG/NACL open to the internet (0.0.0.0/0) — reachable from untrusted origins
  | 'public_exposure' // resource made world-readable/-accessible (public S3, public RDS, public IP)
  | 'encryption' // data-at-rest / in-transit not encrypted
  | 'misconfiguration'; // generic Checkov failed check, not otherwise classified

/** Checkov findings are ordinary Findings (kept as a named alias for callers). */
export type CheckovFinding = Finding;

/** Minimal subset of a Checkov failed-check record we consume. */
export interface CheckovFailedCheck {
  check_id: string;
  bc_check_id?: string | null;
  check_name: string;
  resource: string; // e.g. "aws_security_group.open"
  file_path: string; // e.g. "/main.tf"
  severity?: string | null; // CRITICAL|HIGH|MEDIUM|LOW (often null in OSS Checkov)
}

interface Mapping {
  channel: Finding['channel'];
  category: RiskCategory | CheckovCategory;
}

// Focused map of the highest-value AWS checks → {channel, category}. Anything not
// listed falls through to a generic misconfiguration finding (see classify()).
// check_ids are stable Checkov identifiers (https://www.checkov.io/5.Policy%20Index/terraform.html).
const CHECK_MAP: Record<string, Mapping> = {
  // --- Network exposure: security group / NACL open to 0.0.0.0/0 ---
  CKV_AWS_24: { channel: 'network', category: 'network_exposure' }, // SG ingress 0.0.0.0/0 :22 (SSH)
  CKV_AWS_25: { channel: 'network', category: 'network_exposure' }, // SG ingress 0.0.0.0/0 :3389 (RDP)
  CKV_AWS_260: { channel: 'network', category: 'network_exposure' }, // SG ingress 0.0.0.0/0 :80 (HTTP)
  CKV_AWS_277: { channel: 'network', category: 'network_exposure' }, // SG no unrestricted ingress to all ports
  CKV_AWS_382: { channel: 'network', category: 'network_exposure' }, // SG no unrestricted egress to all ports
  CKV2_AWS_5: { channel: 'network', category: 'network_exposure' }, // SG attached to a resource (unused SG)

  // --- Public exposure: resource reachable from the public internet ---
  CKV_AWS_20: { channel: 'network', category: 'public_exposure' }, // S3 bucket public READ ACL
  CKV_AWS_53: { channel: 'network', category: 'public_exposure' }, // S3 block_public_acls
  CKV_AWS_54: { channel: 'network', category: 'public_exposure' }, // S3 block_public_policy
  CKV_AWS_55: { channel: 'network', category: 'public_exposure' }, // S3 ignore_public_acls
  CKV_AWS_56: { channel: 'network', category: 'public_exposure' }, // S3 restrict_public_buckets
  CKV2_AWS_6: { channel: 'network', category: 'public_exposure' }, // S3 has a public-access block
  CKV_AWS_17: { channel: 'network', category: 'public_exposure' }, // RDS not publicly accessible
  CKV_AWS_88: { channel: 'network', category: 'public_exposure' }, // EC2 instance has no public IP

  // --- Encryption at rest ---
  CKV_AWS_19: { channel: 'network', category: 'encryption' }, // S3 SSE enabled
  CKV_AWS_21: { channel: 'network', category: 'encryption' }, // S3 versioning (data durability)
  CKV_AWS_145: { channel: 'network', category: 'encryption' }, // S3 encrypted with KMS
  CKV_AWS_16: { channel: 'network', category: 'encryption' }, // RDS storage encrypted
  CKV_AWS_3: { channel: 'network', category: 'encryption' }, // EBS volume encrypted
};

// Keyword fallback for unmapped checks: catch the obvious exposure language so we
// don't silently demote a real network/public finding to "misconfiguration".
function classifyByName(name: string): Mapping {
  const n = name.toLowerCase();
  if (/(0\.0\.0\.0|ingress|egress|security group|public.*(access|ip)|publicly)/.test(n)) {
    return { channel: 'network', category: 'network_exposure' };
  }
  if (/(encrypt|kms|tls|ssl|in transit|at rest)/.test(n)) {
    return { channel: 'network', category: 'encryption' };
  }
  return { channel: 'network', category: 'misconfiguration' };
}

function classify(c: CheckovFailedCheck): Mapping {
  return CHECK_MAP[c.check_id] ?? classifyByName(c.check_name);
}

/** Turn Checkov failed checks into normalized (widened) Findings. */
export function normalizeCheckov(failed: CheckovFailedCheck[]): CheckovFinding[] {
  const out: CheckovFinding[] = [];
  for (const c of failed) {
    if (!c || !c.check_id) continue;
    const { channel, category } = classify(c);
    // Subject = the IaC resource, stable across git-ref worktrees because
    // file_path is repo-relative under the worktree root.
    const subject = `${c.file_path}:${c.resource}`;
    out.push({
      source: CHECKOV_SOURCE,
      channel,
      subject,
      category,
      detail: c.check_id,
    });
  }
  return out;
}
