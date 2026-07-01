// Principal reach (P2). "Blast radius = reach × sensitivity" — and reach includes
// how many identities hold a grant, not just what the grant allows. A statement
// on a policy attached to N principals is reachable by all N, so its blast radius
// scales with N. policy-extract.ts counts principals per policy from the CFN
// attachment graph; this maps that count onto the findings for each policy.
//
// The safe/over-approximating direction: unknown attachment (bare policy files)
// defaults to 1, so this never *reduces* a score — it only surfaces the extra
// reach of shared roles.

import { ExtractedPolicy } from './policy-extract';
import { Finding } from './types';

/** policyId -> principal count, for policies attached to more than one principal. */
export function buildReachMap(policies: ExtractedPolicy[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of policies) {
    if (typeof p.principalCount === 'number' && p.principalCount > 1) {
      m.set(p.policyId, p.principalCount);
    }
  }
  return m;
}

/**
 * Tag each finding whose subject (policyId) is a shared policy with the number of
 * principals that carry it. Findings on dedicated (or bare-file) policies are
 * returned unchanged. Pure; no I/O.
 */
export function applyPrincipalReach(findings: Finding[], policies: ExtractedPolicy[]): Finding[] {
  const reach = buildReachMap(policies);
  if (reach.size === 0) return findings;
  return findings.map((f) => (reach.has(f.subject) ? { ...f, reachFactor: reach.get(f.subject) } : f));
}
