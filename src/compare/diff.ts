// Diff findings between a baseline ref and a candidate ref, and assemble the
// ranked Comparison. The same-baseline guarantee lives in the orchestrator;
// here we just do set math (PLAN.md §3, §4).

import { scoreFindings } from './score';
import {
  AnalysisResult,
  Comparison,
  Finding,
  RefDiff,
  ScoredRef,
  Weights,
  findingKey,
} from './types';

export function diffFindings(baseline: Finding[], candidate: Finding[]): { added: Finding[]; removed: Finding[] } {
  const baseKeys = new Set(baseline.map(findingKey));
  const candKeys = new Set(candidate.map(findingKey));
  return {
    added: candidate.filter((f) => !baseKeys.has(findingKey(f))),
    removed: baseline.filter((f) => !candKeys.has(findingKey(f))),
  };
}

function scoreRef(r: AnalysisResult, weights: Weights): ScoredRef {
  const s = scoreFindings(r.findings, weights);
  return { ref: r.ref, score: s.score, byCategory: s.byCategory, findingCount: s.findingCount };
}

export function buildComparison(
  baseline: AnalysisResult,
  candidates: AnalysisResult[],
  weights: Weights
): Comparison {
  const baselineScored = scoreRef(baseline, weights);

  const built = candidates.map((c) => {
    const scored = scoreRef(c, weights);
    const d = diffFindings(baseline.findings, c.findings);
    const diff: RefDiff = { ref: c.ref, added: d.added, removed: d.removed };
    return { scored, diff, deltaVsBaseline: scored.score - baselineScored.score };
  });

  let winner: string | null = null;
  let best = Infinity;
  for (const c of built) {
    if (c.scored.score < best) {
      best = c.scored.score;
      winner = c.scored.ref;
    }
  }

  return { baseline: baselineScored, candidates: built, winner };
}
