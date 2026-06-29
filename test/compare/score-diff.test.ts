import * as assert from 'assert';
import { Finding, DEFAULT_WEIGHTS, AnalysisResult } from '../../src/compare/types';
import { scoreFindings, resolveWeights } from '../../src/compare/score';
import { diffFindings, buildComparison } from '../../src/compare/diff';

function f(category: Finding['category'], detail: string, subject = 'p'): Finding {
  return { source: 'cloudsplaining', channel: 'iam', subject, category, detail };
}

const scoped: Finding[] = [f('breadth', 's3:GetObject')];
const broad: Finding[] = [
  f('breadth', 's3:GetObject'),
  f('breadth', 's3:DeleteObject'),
  f('service_wildcard', 's3'),
  f('permissions_management', 's3:PutBucketAcl'),
];

describe('scoreFindings', () => {
  it('sums category weights', () => {
    // 2*breadth(1) + service_wildcard(100) + permissions_management(50) = 152
    assert.strictEqual(scoreFindings(broad).score, 152);
    assert.strictEqual(scoreFindings(scoped).score, 1);
  });

  it('does not count infrastructure_modification by default (no double count)', () => {
    assert.strictEqual(DEFAULT_WEIGHTS.category.infrastructure_modification, 0);
  });

  it('honors tunable weights merged over defaults', () => {
    const w = resolveWeights({ category: { breadth: 5 } as any });
    assert.strictEqual(w.category.breadth, 5);
    assert.strictEqual(w.category.service_wildcard, 100); // default preserved
  });
});

describe('diffFindings', () => {
  it('reports added and removed findings', () => {
    const d = diffFindings(scoped, broad);
    assert.ok(d.added.some((x) => x.detail === 's3:DeleteObject'));
    assert.ok(d.added.some((x) => x.category === 'service_wildcard'));
    assert.strictEqual(d.removed.length, 0);
  });
});

describe('buildComparison', () => {
  const baseline: AnalysisResult = { ref: 'main', findings: [] };
  const a: AnalysisResult = { ref: 'fix-broad', findings: broad };
  const b: AnalysisResult = { ref: 'fix-scoped', findings: scoped };

  const cmp = buildComparison(baseline, [a, b], DEFAULT_WEIGHTS);

  it('picks the lowest-scoring candidate as the smallest blast radius', () => {
    assert.strictEqual(cmp.winner, 'fix-scoped');
  });

  it('computes delta vs the same baseline for each candidate', () => {
    const broadCand = cmp.candidates.find((c) => c.scored.ref === 'fix-broad')!;
    assert.strictEqual(broadCand.deltaVsBaseline, 152);
    assert.strictEqual(broadCand.diff.added.length, broad.length);
  });
});
