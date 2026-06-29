// Cycle-safe blast-radius traversal + edge-weighted severity estimate.
// Pure functions, no VS Code / DOM dependency — shared by host and webview.
// See DESIGN.md §4 and §5.2.

import { Direction, GraphData, GraphEdge, Severity } from './types';

interface Adjacency {
  // outgoing[u] = edges where u is the dependent (u depends on target)
  outgoing: Map<string, GraphEdge[]>;
  // incoming[v] = edges where v is the dependency (some source depends on v)
  incoming: Map<string, GraphEdge[]>;
}

export function buildAdjacency(graph: GraphData): Adjacency {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);
  }
  return { outgoing, incoming };
}

/**
 * Set of nodes reachable from `startId` in the requested direction.
 *
 * - dependents:   "what breaks if I change start" — follow INCOMING edges
 *                 (nodes that depend, transitively, on start).
 * - dependencies: "what start needs"               — follow OUTGOING edges.
 *
 * Cycle-safe via a visited set (DESIGN.md §4.3). `startId` is excluded.
 */
export function reachable(
  graph: GraphData,
  startId: string,
  direction: Direction,
  adj: Adjacency = buildAdjacency(graph)
): Set<string> {
  const visited = new Set<string>([startId]);
  const result = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    const edges =
      direction === 'dependents'
        ? adj.incoming.get(cur) ?? []
        : adj.outgoing.get(cur) ?? [];
    for (const e of edges) {
      const next = direction === 'dependents' ? e.source : e.target;
      if (!visited.has(next)) {
        visited.add(next);
        result.add(next);
        stack.push(next);
      }
    }
  }
  return result;
}

export interface EstimateEntry {
  severity: Severity;
  hops: number; // shortest distance from the changed node
}

/**
 * Edge-weighted severity ESTIMATE for the dependents of `startId`, used when no
 * real plan is available (DESIGN.md §5.2). Heuristic, not ground truth:
 *
 *  - reachable via a hard edge at distance 1  -> "replace" (directly consumes an
 *    attribute of the changed resource; worst case if the change is a replace).
 *  - reachable via a hard path at distance >=2 -> "update" (indirect value flow).
 *  - reachable only through soft (DependsOn) edges -> "noop" (ordering only; no
 *    value flows, so a value change does not break it).
 */
export function estimateImpact(
  graph: GraphData,
  startId: string,
  adj: Adjacency = buildAdjacency(graph)
): Map<string, EstimateEntry> {
  // BFS over incoming edges tracking the shortest distance reached via a path
  // whose final edge is hard, plus whether the node is reachable at all.
  const minHardDist = new Map<string, number>();
  const reachableAny = new Set<string>();

  // queue of [node, distance]
  const queue: Array<[string, number]> = [[startId, 0]];
  const seen = new Set<string>([startId]);
  while (queue.length) {
    const [cur, dist] = queue.shift()!;
    for (const e of adj.incoming.get(cur) ?? []) {
      const child = e.source;
      reachableAny.add(child);
      if (e.kind === 'hard') {
        const d = dist + 1;
        if (!minHardDist.has(child) || d < minHardDist.get(child)!) {
          minHardDist.set(child, d);
        }
      }
      if (!seen.has(child)) {
        seen.add(child);
        queue.push([child, dist + 1]);
      }
    }
  }

  const out = new Map<string, EstimateEntry>();
  for (const id of reachableAny) {
    const hd = minHardDist.get(id);
    if (hd === undefined) {
      out.set(id, { severity: 'noop', hops: 1 });
    } else if (hd <= 1) {
      out.set(id, { severity: 'replace', hops: hd });
    } else {
      out.set(id, { severity: 'update', hops: hd });
    }
  }
  return out;
}

/** Detect whether the graph contains a directed cycle (DESIGN.md §4.3). */
export function hasCycle(graph: GraphData, adj: Adjacency = buildAdjacency(graph)): boolean {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n.id, WHITE);

  const dfs = (start: string): boolean => {
    // iterative DFS with explicit coloring to stay stack-safe on large graphs
    const stack: Array<{ node: string; idx: number }> = [{ node: start, idx: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = adj.outgoing.get(frame.node) ?? [];
      if (frame.idx < edges.length) {
        const next = edges[frame.idx++].target;
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) return true;
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, idx: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
    return false;
  };

  for (const n of graph.nodes) {
    if (color.get(n.id) === WHITE && dfs(n.id)) return true;
  }
  return false;
}
