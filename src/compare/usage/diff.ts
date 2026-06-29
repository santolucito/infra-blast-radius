// Granted − Used: the unnecessary blast radius.
//
//   GRANTED = the concrete IAM actions a policy allows (the ceiling), obtained
//             by extracting the policy (policy-extract.ts) and expanding it with
//             Cloudsplaining (wildcards like s3:* → ~168 concrete actions).
//   USED    = the IAM actions the application code actually invokes (extractor).
//   UNNECESSARY = GRANTED − USED.
//
// The high-value subset is UNNECESSARY ∩ HIGH-RISK: grants the code never uses
// that also carry privilege-escalation / data-exfiltration / write / perms-mgmt
// risk (e.g. s3:DeleteObject, s3:PutBucketPolicy granted by an s3:* fix whose
// code only reads one object).
//
// We reuse the existing CloudsplainingAdapter (read-only import) for expansion,
// so the wildcard-expansion + risk classification is the same boundary the rest
// of the tool already trusts.

import * as path from 'path';
import { CloudsplainingAdapter } from '../adapters/cloudsplaining';
import { extractPolicies } from '../policy-extract';
import { Channel } from '../types';
import { extractUsage, UsageHit } from './extractor';

/**
 * Local Finding-shaped object for unused grants. We do NOT edit the shared
 * types.ts; this introduces a new category 'unused_grant' that would be added
 * to RiskCategory when wired in (see INTEGRATION-grantused.md).
 */
export type UsageRiskCategory = 'unused_grant';

export interface UsageFinding {
  source: 'granted-vs-used';
  channel: Channel; // 'iam'
  subject: string; // policyId
  category: UsageRiskCategory;
  detail: string; // the unnecessary IAM action
  /** Risk categories this unnecessary action also belongs to (may be empty). */
  risks: string[];
}

/** Cloudsplaining risk categories we treat as "high-risk" for an unused grant. */
export const HIGH_RISK_CATEGORIES = [
  'privilege_escalation',
  'data_exfiltration',
  'credentials_exposure',
  'permissions_management',
  'write',
] as const;

const RISK_CATEGORIES = [
  ...HIGH_RISK_CATEGORIES,
  'tagging',
  'infrastructure_modification',
] as const;

export interface GrantUsedResult {
  policyId: string;
  codeDir: string;
  policyFile: string;
  granted: string[]; // sorted concrete allowed actions
  used: string[]; // sorted actions invoked by code
  unnecessary: string[]; // sorted granted − used
  /** Unnecessary actions that are also high-risk, with their risk categories. */
  unnecessaryHighRisk: Array<{ action: string; risks: string[] }>;
  counts: { granted: number; used: number; unnecessary: number; unnecessaryHighRisk: number };
  /** Finding-shaped objects for the unnecessary actions (channel 'iam'). */
  findings: UsageFinding[];
  /** Where each used action was detected (explainability). */
  usageHits: UsageHit[];
}

export interface GrantUsedOptions {
  repoRoot: string;
  codeDir: string; // relative to repoRoot (or absolute)
  policyFile: string; // relative to repoRoot (or absolute); policy-extract reads it
  python?: string;
  shimPath: string;
}

const lc = (s: string) => s.toLowerCase();

/**
 * Compute granted − used for one (codeDir, policyFile) pair. If the policy file
 * yields multiple policy documents, they are unioned into one ceiling (the code
 * dir is governed by all of them together).
 */
export async function computeGrantUsed(opts: GrantUsedOptions): Promise<GrantUsedResult> {
  const codeAbs = path.resolve(opts.repoRoot, opts.codeDir);
  const policyRel = path.isAbsolute(opts.policyFile)
    ? path.relative(opts.repoRoot, opts.policyFile)
    : opts.policyFile;

  // GRANTED: extract + expand via Cloudsplaining (reuse the adapter).
  const policies = extractPolicies(opts.repoRoot, policyRel);
  if (policies.length === 0) {
    throw new Error(`no IAM policy documents found in ${opts.policyFile}`);
  }
  const adapter = new CloudsplainingAdapter({ python: opts.python, shimPath: opts.shimPath });
  if (!(await adapter.available())) {
    throw new Error('cloudsplaining not available (need python with cloudsplaining + shim).');
  }
  const findings = await adapter.analyze({ rootDir: opts.repoRoot, policies });

  const grantedSet = new Set<string>();
  // action(lowercased) -> set of risk categories
  const riskByAction = new Map<string, Set<string>>();
  const riskCats = new Set<string>(RISK_CATEGORIES);
  for (const f of findings) {
    if (f.category === 'breadth') grantedSet.add(f.detail);
    else if (riskCats.has(f.category)) {
      let s = riskByAction.get(lc(f.detail));
      if (!s) riskByAction.set(lc(f.detail), (s = new Set()));
      s.add(f.category);
    }
  }

  // USED: from static code analysis.
  const usage = extractUsage(codeAbs);
  const usedSet = new Set(usage.actions);
  const usedLower = new Set([...usedSet].map(lc));

  // UNNECESSARY = granted − used (case-insensitive compare).
  const unnecessary = [...grantedSet].filter((a) => !usedLower.has(lc(a))).sort();

  const highRiskSet = new Set<string>(HIGH_RISK_CATEGORIES);
  const unnecessaryHighRisk: Array<{ action: string; risks: string[] }> = [];
  const findingsOut: UsageFinding[] = [];
  const policyId = policies.map((p) => p.policyId).join('+');

  for (const action of unnecessary) {
    const risks = [...(riskByAction.get(lc(action)) ?? [])].sort();
    findingsOut.push({
      source: 'granted-vs-used',
      channel: 'iam',
      subject: policyId,
      category: 'unused_grant',
      detail: action,
      risks,
    });
    if (risks.some((r) => highRiskSet.has(r))) {
      unnecessaryHighRisk.push({ action, risks: risks.filter((r) => highRiskSet.has(r)) });
    }
  }

  return {
    policyId,
    codeDir: opts.codeDir,
    policyFile: policyRel,
    granted: [...grantedSet].sort(),
    used: [...usedSet].sort(),
    unnecessary,
    unnecessaryHighRisk,
    counts: {
      granted: grantedSet.size,
      used: usedSet.size,
      unnecessary: unnecessary.length,
      unnecessaryHighRisk: unnecessaryHighRisk.length,
    },
    findings: findingsOut,
    usageHits: usage.hits,
  };
}
