// Terraform adapter — delegates to the `terraform` CLI (DESIGN.md §2.3).
// The DOT and plan-JSON parsing are pure functions (unit-testable); the CLI
// invocations are thin wrappers. No VS Code dependency.

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  GraphData,
  GraphEdge,
  GraphNode,
  Severity,
  emptyGraph,
  makeEdgeId,
} from '../graph/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

// A `terraform graph` node label looks like: "[root] aws_instance.web (expand)"
// or "[root] module.net.aws_vpc.main (expand)". We strip the "[root] " prefix
// and the trailing " (expand)" / " (close)" annotations.
function cleanLabel(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\[root\]\s+/, '');
  s = s.replace(/\s+\((expand|close|root)\)$/, '');
  return s.trim();
}

// Keep only real resource / data addresses; drop provider, var, local, output,
// and meta nodes that terraform graph emits.
function isResourceAddress(addr: string): boolean {
  if (!addr) return false;
  if (/^provider\[/.test(addr)) return false;
  if (/^(var|local|output)\./.test(addr)) return false;
  if (/^meta\./.test(addr)) return false;
  if (addr.startsWith('root')) return false;
  // module.<name>.<...> or <type>.<name> or data.<type>.<name>
  return addr.includes('.');
}

function moduleOf(addr: string): string | null {
  const m = addr.match(/^((?:module\.[^.]+\.)+)/);
  if (!m) return null;
  // strip trailing dot -> "module.net" or "module.net.module.inner"
  return m[1].replace(/\.$/, '');
}

function tfCategory(addr: string): string {
  const a = addr.toLowerCase();
  if (/(vpc|subnet|security_group|route|gateway|network)/.test(a)) return 'network';
  if (/(instance|lambda|function|ecs|autoscaling|container)/.test(a)) return 'compute';
  if (/(s3|bucket|dynamodb|rds|db_|efs|table|database)/.test(a)) return 'storage';
  if (/(iam|role|policy|kms|secret)/.test(a)) return 'security';
  return 'unknown';
}

/**
 * Parse `terraform graph` DOT output into the normalized schema.
 *
 * Modules are flattened (addresses stay fully-qualified) and cross-module edges
 * are preserved, so the graph stays connected (DESIGN.md §2.3, §7). Edge
 * direction from terraform graph is dependent -> dependency, matching our
 * convention. terraform graph does not distinguish depends_on from implicit
 * references, so all edges are tagged "hard".
 */
export function parseTerraformDot(dot: string): GraphData {
  const graph = emptyGraph('terraform');
  const nodeIds = new Set<string>();
  const edgeMap = new Map<string, GraphEdge>();

  // Match: "A" -> "B"   (with optional attribute lists / trailing semicolons)
  const edgeRe = /"([^"]+)"\s*->\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = edgeRe.exec(dot)) !== null) {
    const src = cleanLabel(m[1]);
    const dst = cleanLabel(m[2]);
    if (!isResourceAddress(src) || !isResourceAddress(dst) || src === dst) continue;
    nodeIds.add(src);
    nodeIds.add(dst);
    const id = makeEdgeId(src, dst);
    if (!edgeMap.has(id)) {
      edgeMap.set(id, { id, source: src, target: dst, kind: 'hard' });
    }
  }

  // Also pick up standalone node declarations so isolated resources appear.
  const nodeRe = /"([^"]+)"\s*(\[[^\]]*\])?\s*;?/g;
  while ((m = nodeRe.exec(dot)) !== null) {
    const label = cleanLabel(m[1]);
    if (isResourceAddress(label)) nodeIds.add(label);
  }

  const nodes: GraphNode[] = [];
  for (const id of nodeIds) {
    nodes.push({
      id,
      label: id,
      type: tfCategory(id),
      module: moduleOf(id),
      severity: null,
    });
  }

  graph.nodes = nodes;
  graph.edges = [...edgeMap.values()];
  return graph;
}

// ---------------------------------------------------------------------------
// Plan-based severity (DESIGN.md §5.1)
// ---------------------------------------------------------------------------

type TfAction = 'no-op' | 'create' | 'read' | 'update' | 'delete';

interface TfResourceChange {
  address: string;
  change: { actions: TfAction[] };
}

interface TfShowJson {
  resource_changes?: TfResourceChange[];
}

function actionsToSeverity(actions: TfAction[]): Severity {
  const set = new Set(actions);
  // delete+create (in either order) = replace
  if (set.has('delete') && set.has('create')) return 'replace';
  if (set.has('delete')) return 'destroy';
  if (set.has('update')) return 'update';
  return 'noop';
}

/** Map `terraform show -json <plan>` output to per-address severities. */
export function parseTerraformShowJson(json: string): Map<string, Severity> {
  const out = new Map<string, Severity>();
  let data: TfShowJson;
  try {
    data = JSON.parse(json);
  } catch {
    return out;
  }
  for (const rc of data.resource_changes ?? []) {
    if (rc && rc.address && rc.change?.actions) {
      out.set(rc.address, actionsToSeverity(rc.change.actions));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

export interface TerraformOptions {
  /** terraform executable path. */
  bin: string;
  /** working directory (the config / module root). */
  cwd: string;
}

export async function isTerraformAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Run `terraform graph` and return the structural graph. */
export async function runTerraformGraph(opts: TerraformOptions): Promise<GraphData> {
  const { stdout } = await execFileAsync(opts.bin, ['graph'], {
    cwd: opts.cwd,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseTerraformDot(stdout);
}

/**
 * Run `terraform plan` + `terraform show -json` to produce per-address
 * severities. Requires an initialized workspace and credentials (on-demand
 * only — never on the live buffer). Throws on failure; caller surfaces it.
 */
export async function runTerraformPlanSeverity(
  opts: TerraformOptions
): Promise<Map<string, Severity>> {
  const planFile = '.blast-radius.tfplan';
  await execFileAsync(opts.bin, ['plan', '-input=false', '-lock=false', `-out=${planFile}`], {
    cwd: opts.cwd,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const { stdout } = await execFileAsync(opts.bin, ['show', '-json', planFile], {
    cwd: opts.cwd,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseTerraformShowJson(stdout);
}
