// Severity-weighted scoring of normalized findings (PLAN.md §5).

import { DEFAULT_WEIGHTS, Finding, RiskCategory, Weights } from './types';

export interface Scored {
  score: number;
  byCategory: Record<string, number>;
  findingCount: number;
}

export function scoreFindings(findings: Finding[], weights: Weights = DEFAULT_WEIGHTS): Scored {
  const byCategory: Record<string, number> = {};
  let score = 0;
  for (const f of findings) {
    const w = weights.category[f.category as RiskCategory] ?? 0;
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
