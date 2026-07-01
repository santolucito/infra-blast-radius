// Granted-vs-used lens, orchestrator path (P2).
//
// usage/diff.ts::computeGrantUsed is the standalone entry point — it runs
// Cloudsplaining itself to expand a policy. Inside the orchestrator, the
// Cloudsplaining findings ALREADY exist for the ref, so re-expanding would be
// wasteful and could drift. This module instead takes the existing Finding[]
// and the ref's worktree, links code dirs to policies (blast-usage.json), and
// marks the findings whose action the linked code never invokes as `unused`.
// Scoring then applies UNUSED_MULTIPLIER (see score.ts). No second tool run.
//
// It is a NO-OP when the repo has no blast-usage.json manifest, so it is safe to
// call unconditionally per ref.

import * as fs from 'fs';
import * as path from 'path';
import { Finding } from '../types';
import { extractUsedActions } from './extractor';
import { resolveLinks } from './link';

/** IAM categories that represent a *granted action* (so the lens can re-weight
 * them). service_wildcard (detail = service, not an action) and the checkov /
 * unused_grant categories are intentionally excluded. */
const GRANT_CATEGORIES = new Set<string>([
  'breadth',
  'privilege_escalation',
  'data_exfiltration',
  'credentials_exposure',
  'permissions_management',
  'write',
  'tagging',
  'infrastructure_modification',
]);

const HIGH_RISK = new Set<string>([
  'privilege_escalation',
  'data_exfiltration',
  'credentials_exposure',
  'permissions_management',
  'write',
]);

const lc = (s: string) => s.toLowerCase();

/** The file part of a Cloudsplaining policyId ("file.json#Logical/Name" -> "file.json"). */
function subjectFile(subject: string): string {
  return path.normalize(subject.split('#')[0]);
}

export interface UsageLensResult {
  /** Findings with `unused` marked, plus weight-0 `unused_grant` marker findings. */
  findings: Finding[];
  /** True when a manifest linked at least one code dir → policy. */
  active: boolean;
  /** Distinct granted-but-unused actions across all linked policies. */
  unusedActions: number;
  /** …of which are also high-risk (priv-esc / data-exfil / creds / perms / write). */
  unusedHighRisk: number;
}

/**
 * Mark granted-but-unused findings for one ref's worktree. Returns a new findings
 * array (originals are cloned where mutated) plus summary counts. Pure w.r.t.
 * external tools — only reads the worktree's code + manifest.
 */
export function applyUsageLens(findings: Finding[], worktreeDir: string): UsageLensResult {
  const links = resolveLinks(worktreeDir);
  if (links.length === 0) {
    return { findings, active: false, unusedActions: 0, unusedHighRisk: 0 };
  }

  // For each linked policy file, the set of actions its code actually uses.
  // (Multiple code dirs can map to the same policy file; union their usage.)
  const usedByPolicy = new Map<string, Set<string>>();
  for (const link of links) {
    const codeAbs = path.resolve(worktreeDir, link.codeDir);
    const used = fs.existsSync(codeAbs)
      ? new Set([...extractUsedActions(codeAbs)].map(lc))
      : new Set<string>();
    const key = path.normalize(link.policyFile);
    const existing = usedByPolicy.get(key);
    if (existing) used.forEach((a) => existing.add(a));
    else usedByPolicy.set(key, used);
  }

  const out: Finding[] = [];
  // Track distinct unused actions (by subject+action) for reporting + markers.
  const unusedSeen = new Set<string>();
  const highRiskActions = new Set<string>();
  const markerKeys = new Set<string>();

  for (const f of findings) {
    const used = f.channel === 'iam' ? usedByPolicy.get(subjectFile(f.subject)) : undefined;
    const isGrant = used !== undefined && GRANT_CATEGORIES.has(f.category) && f.detail !== '';
    const isUnused = isGrant && !used!.has(lc(f.detail));

    if (isUnused) {
      out.push({ ...f, unused: true });
      const id = `${f.subject}|${lc(f.detail)}`;
      if (f.category === 'breadth') unusedSeen.add(id);
      if (HIGH_RISK.has(f.category)) highRiskActions.add(id);
      // One weight-0 marker finding per (subject, action) for diff/reporting.
      const mk = `${f.subject}|${f.detail}`;
      if (!markerKeys.has(mk)) {
        markerKeys.add(mk);
        out.push({
          source: 'granted-vs-used',
          channel: 'iam',
          subject: f.subject,
          category: 'unused_grant',
          detail: f.detail,
        });
      }
    } else {
      out.push(f);
    }
  }

  return {
    findings: out,
    active: true,
    unusedActions: unusedSeen.size,
    unusedHighRisk: highRiskActions.size,
  };
}
