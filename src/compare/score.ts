// Severity-weighted scoring of normalized findings (PLAN.md §5).

import { DEFAULT_WEIGHTS, Finding, RiskCategory, Weights } from './types';

export interface Scored {
  score: number;
  byCategory: Record<string, number>;
  findingCount: number;
}

/**
 * Granted-vs-used penalty (P2). A finding whose action is granted but never
 * invoked by the linked code has its weight multiplied by this factor — so a
 * fix that grants unused, high-risk actions ranks worse than one whose grants
 * are all exercised. It is a re-weighting of EXISTING findings, not a new
 * additive surface, which keeps the score from double-counting (PLAN.md §8).
 * The lens is conservative: a missed SDK call over-counts "unused", so the
 * factor is modest and drives prioritization, not a hard removal gate.
 */
export const UNUSED_MULTIPLIER = 2;

export function scoreFindings(findings: Finding[], weights: Weights = DEFAULT_WEIGHTS): Scored {
  const byCategory: Record<string, number> = {};
  let score = 0;
  for (const f of findings) {
    let w = weights.category[f.category as RiskCategory] ?? 0;
    if (f.unused) w *= UNUSED_MULTIPLIER;
    score += w;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + w;
  }
  return { score, byCategory, findingCount: findings.length };
}

/** Merge user-supplied weights over the defaults (tunable, PLAN.md §5). */
export function resolveWeights(partial?: Partial<Weights>): Weights {
  if (!partial?.category) return DEFAULT_WEIGHTS;
  return { category: { ...DEFAULT_WEIGHTS.category, ...partial.category } };
}
