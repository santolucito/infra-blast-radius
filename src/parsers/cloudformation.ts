// CloudFormation parser — operates on the in-memory buffer (DESIGN.md §2.2).
// No VS Code dependency, so it is unit-testable in plain Node.

import * as yaml from 'js-yaml';
import {
  EdgeKind,
  GraphData,
  GraphEdge,
  GraphNode,
  emptyGraph,
  makeEdgeId,
} from '../graph/types';

// ---------------------------------------------------------------------------
// CloudFormation YAML uses custom tags (!Ref, !GetAtt, !Sub, …) that default
// YAML parsers reject. We register a schema that normalizes every tag into its
// canonical object form ({ Ref: x } / { "Fn::GetAtt": x }) so downstream code
// sees one uniform structure regardless of JSON vs YAML, short vs long form.
// ---------------------------------------------------------------------------

const FN_TAGS = [
  'Base64',
  'Cidr',
  'FindInMap',
  'GetAtt',
  'GetAZs',
  'ImportValue',
  'Join',
  'Select',
  'Split',
  'Sub',
  'Transform',
  'And',
  'Equals',
  'If',
  'Not',
  'Or',
];

function buildCfnSchema(): yaml.Schema {
  const types: yaml.Type[] = [];
  const kinds: Array<'scalar' | 'sequence' | 'mapping'> = ['scalar', 'sequence', 'mapping'];

  // !Ref and !Condition map to a bare key; everything else to Fn::<Name>.
  for (const kind of kinds) {
    types.push(
      new yaml.Type('!Ref', { kind, construct: (data) => ({ Ref: data }) }),
      new yaml.Type('!Condition', { kind, construct: (data) => ({ Condition: data }) })
    );
    for (const name of FN_TAGS) {
      types.push(
        new yaml.Type(`!${name}`, {
          kind,
          construct: (data) => ({ [`Fn::${name}`]: data }),
        })
      );
    }
  }
  return yaml.DEFAULT_SCHEMA.extend(types);
}

const CFN_SCHEMA = buildCfnSchema();

/** Load a CloudFormation/JSON/YAML document tolerating CFN intrinsic tags. */
export function loadTemplate(text: string): unknown {
  return yaml.load(text, { schema: CFN_SCHEMA });
}

/** Quick heuristic: does this document look like a CloudFormation template? */
export function looksLikeCloudFormation(text: string): boolean {
  try {
    const doc = yaml.load(text, { schema: CFN_SCHEMA }) as Record<string, unknown> | undefined;
    return !!doc && typeof doc === 'object' && typeof (doc as any).Resources === 'object';
  } catch {
    return false;
  }
}

interface Found {
  target: string;
  kind: EdgeKind;
}

// Match ${LogicalId} and ${LogicalId.Attr} inside Fn::Sub strings, skipping
// escaped ${!Literal} sequences. Returns the LogicalId portion.
const SUB_REF_RE = /\$\{([^}]+)\}/g;

function collectSubRefs(template: string, out: Found[]): void {
  let m: RegExpExecArray | null;
  while ((m = SUB_REF_RE.exec(template)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith('!')) continue; // ${!Literal} — escaped, not a ref
    const logicalId = inner.split('.')[0].trim();
    if (logicalId) out.push({ target: logicalId, kind: 'hard' });
  }
}

/** Recursively walk a resource body collecting candidate references. */
function collectRefs(node: unknown, out: Found[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Intrinsic forms produce edges and we do NOT recurse into their bare value
  // as if it were a resource body (it is a logical id / attr path).
  if (keys.length === 1) {
    const [key] = keys;
    const val = obj[key];
    if (key === 'Ref') {
      if (typeof val === 'string') out.push({ target: val, kind: 'hard' });
      return;
    }
    if (key === 'Fn::GetAtt') {
      // "A.Attr" or ["A", "Attr", ...]
      if (typeof val === 'string') {
        out.push({ target: val.split('.')[0], kind: 'hard' });
      } else if (Array.isArray(val) && typeof val[0] === 'string') {
        out.push({ target: val[0], kind: 'hard' });
      }
      return;
    }
    if (key === 'Fn::Sub') {
      // "str" or ["str", { vars }]
      if (typeof val === 'string') {
        collectSubRefs(val, out);
      } else if (Array.isArray(val)) {
        if (typeof val[0] === 'string') collectSubRefs(val[0], out);
        // recurse into the variable map values (they may themselves be refs),
        // but the variable NAMES are local and not resource ids.
        if (val[1]) collectRefs(val[1], out);
      }
      return;
    }
    // Other Fn::* (Join, Select, If, …) — just recurse into the value.
  }

  for (const k of keys) collectRefs(obj[k], out);
}

export function parseCloudFormation(text: string): GraphData {
  const graph = emptyGraph('cloudformation');

  let doc: any;
  try {
    doc = yaml.load(text, { schema: CFN_SCHEMA });
  } catch (e) {
    graph.warnings.push(`YAML/JSON parse error: ${(e as Error).message}`);
    return graph;
  }

  if (!doc || typeof doc !== 'object' || typeof doc.Resources !== 'object') {
    graph.warnings.push('No top-level "Resources" map found.');
    return graph;
  }

  const resources = doc.Resources as Record<string, any>;
  const logicalIds = new Set(Object.keys(resources));

  const nodes: GraphNode[] = [];
  const edgeMap = new Map<string, GraphEdge>();

  for (const [id, body] of Object.entries(resources)) {
    if (!body || typeof body !== 'object') continue;
    const cfnType: string = typeof body.Type === 'string' ? body.Type : 'Unknown';
    nodes.push({
      id,
      label: `${shortType(cfnType)} (${id})`,
      type: categorize(cfnType),
      module: null,
      severity: null,
    });
  }

  for (const [id, body] of Object.entries(resources)) {
    if (!body || typeof body !== 'object') continue;
    const found: Found[] = [];

    // Implicit refs anywhere in Properties / Metadata / etc.
    collectRefs(body.Properties, found);

    // Explicit DependsOn -> soft edges.
    const dependsOn = body.DependsOn;
    if (typeof dependsOn === 'string') found.push({ target: dependsOn, kind: 'soft' });
    else if (Array.isArray(dependsOn)) {
      for (const d of dependsOn) if (typeof d === 'string') found.push({ target: d, kind: 'soft' });
    }

    for (const f of found) {
      // Filter to real resource logical ids (a Ref may target a Parameter or
      // pseudo-parameter such as AWS::Region — not a resource edge).
      if (!logicalIds.has(f.target) || f.target === id) continue;
      const edgeId = makeEdgeId(id, f.target);
      const existing = edgeMap.get(edgeId);
      // A hard edge dominates a soft one if the same pair appears via both.
      if (!existing) {
        edgeMap.set(edgeId, { id: edgeId, source: id, target: f.target, kind: f.kind });
      } else if (existing.kind === 'soft' && f.kind === 'hard') {
        existing.kind = 'hard';
      }
    }
  }

  graph.nodes = nodes;
  graph.edges = [...edgeMap.values()];
  return graph;
}

function shortType(cfnType: string): string {
  // "AWS::EC2::Instance" -> "Instance"
  const parts = cfnType.split('::');
  return parts[parts.length - 1] || cfnType;
}

// Minimal, intentionally partial category map (DESIGN.md §3.1).
function categorize(cfnType: string): string {
  const t = cfnType.toLowerCase();
  if (/(vpc|subnet|securitygroup|routetable|gateway|::ec2::(vpc|subnet|route))/.test(t))
    return 'network';
  if (/(instance|lambda|function|ecs|autoscaling|::ec2::instance)/.test(t)) return 'compute';
  if (/(s3|bucket|dynamodb|rds|table|efs|database)/.test(t)) return 'storage';
  if (/(iam|role|policy|kms|secret)/.test(t)) return 'security';
  return 'unknown';
}
