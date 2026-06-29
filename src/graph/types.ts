// Provider-agnostic graph contract shared by the parser subsystem, the severity
// engine, and the webview. See DESIGN.md §3.

export type Provider = 'terraform' | 'cloudformation';

/** An edge `source -> target` means `source` DEPENDS ON `target`. */
export type EdgeKind = 'hard' | 'soft';

/** Real action severity (from a plan / change set), or an estimate. */
export type Severity = 'noop' | 'update' | 'replace' | 'destroy';

export type Direction = 'dependents' | 'dependencies';

export interface GraphNode {
  id: string;
  label: string;
  type: string; // presentation category; never affects traversal
  module: string | null; // e.g. "module.net" when flattened from a TF module
  severity: Severity | null; // filled by the severity overlay
}

export interface GraphEdge {
  id: string; // derived "source->target" so duplicates collapse
  source: string; // the dependent
  target: string; // the dependency
  kind: EdgeKind;
}

export interface GraphData {
  schemaVersion: 1;
  provider: Provider;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

export function makeEdgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

export function emptyGraph(provider: Provider): GraphData {
  return { schemaVersion: 1, provider, nodes: [], edges: [], warnings: [] };
}
