import * as assert from 'assert';
import { GraphData, GraphEdge, makeEdgeId } from '../src/graph/types';
import { estimateImpact, hasCycle, reachable } from '../src/graph/traversal';

function g(edges: Array<[string, string, 'hard' | 'soft']>, extraNodes: string[] = []): GraphData {
  const ids = new Set<string>(extraNodes);
  const es: GraphEdge[] = edges.map(([s, t, kind]) => {
    ids.add(s);
    ids.add(t);
    return { id: makeEdgeId(s, t), source: s, target: t, kind };
  });
  return {
    schemaVersion: 1,
    provider: 'terraform',
    nodes: [...ids].map((id) => ({ id, label: id, type: 'unknown', module: null, severity: null })),
    edges: es,
    warnings: [],
  };
}

// VPC <- Subnet <- EC2 ; SG depends on VPC (all hard)
const base = g([
  ['Subnet', 'VPC', 'hard'],
  ['EC2', 'Subnet', 'hard'],
  ['SG', 'VPC', 'hard'],
]);

describe('reachable()', () => {
  it('finds all transitive dependents of VPC', () => {
    const r = reachable(base, 'VPC', 'dependents');
    assert.deepStrictEqual([...r].sort(), ['EC2', 'SG', 'Subnet']);
  });

  it('finds dependencies in the other direction', () => {
    const r = reachable(base, 'EC2', 'dependencies');
    assert.deepStrictEqual([...r].sort(), ['Subnet', 'VPC']);
  });

  it('excludes the start node', () => {
    assert.ok(!reachable(base, 'VPC', 'dependents').has('VPC'));
  });
});

describe('cycle safety', () => {
  const cyclic = g([
    ['A', 'B', 'hard'],
    ['B', 'A', 'hard'],
    ['C', 'A', 'hard'],
  ]);

  it('detects cycles', () => {
    assert.strictEqual(hasCycle(cyclic), true);
    assert.strictEqual(hasCycle(base), false);
  });

  it('terminates on cyclic reachability', () => {
    const r = reachable(cyclic, 'A', 'dependents');
    assert.deepStrictEqual([...r].sort(), ['B', 'C']);
  });
});

describe('estimateImpact()', () => {
  it('grades by hard-edge distance', () => {
    const est = estimateImpact(base, 'VPC');
    assert.strictEqual(est.get('Subnet')?.severity, 'replace'); // dist 1, hard
    assert.strictEqual(est.get('SG')?.severity, 'replace'); // dist 1, hard
    assert.strictEqual(est.get('EC2')?.severity, 'update'); // dist 2, hard
  });

  it('treats soft-only dependents as no-op', () => {
    // X depends on Y only via DependsOn (soft) -> value change does not break X.
    const soft = g([['X', 'Y', 'soft']]);
    const est = estimateImpact(soft, 'Y');
    assert.strictEqual(est.get('X')?.severity, 'noop');
  });
});
