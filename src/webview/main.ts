// Webview frontend: renders the graph with Cytoscape + dagre, runs blast-radius
// traversal locally on selection, and recolors with real severity when the host
// sends a plan result. See DESIGN.md §2.5 / §5.3.

import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { Direction, GraphData, Severity } from '../graph/types';
import { estimateImpact, reachable } from '../graph/traversal';
import { HostMessage } from '../protocol';

cytoscape.use(dagre);

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscodeApi = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let cy: Core | undefined;
let graph: GraphData | undefined;
let direction: Direction = 'dependents';
let selectedId: string | undefined;
/** Plan-based severities, keyed by node id; empty until a plan runs. */
let planSeverity: Record<string, Severity> = {};

function toElements(g: GraphData): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  for (const n of g.nodes) {
    els.push({ data: { id: n.id, label: n.label, type: n.type } });
  }
  for (const e of g.edges) {
    els.push({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind } });
  }
  return els;
}

function render(g: GraphData): void {
  graph = g;
  planSeverity = {};
  selectedId = undefined;

  if (cy) cy.destroy();
  cy = cytoscape({
    container: $('cy'),
    elements: toElements(g),
    layout: { name: 'dagre', rankDir: 'RL', nodeSep: 30, rankSep: 60 } as any,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': 10,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '120px',
          width: 'label',
          height: 28,
          padding: '6px',
          shape: 'round-rectangle',
          'background-color': '#3a3d41',
          color: '#e7e7e7',
          'border-width': 1,
          'border-color': '#5a5d61',
          'transition-property': 'background-color, opacity, border-color',
          'transition-duration': 150 as any,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': '#5a5d61',
          'target-arrow-color': '#5a5d61',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'arrow-scale': 0.8,
        },
      },
      { selector: 'edge[kind = "soft"]', style: { 'line-style': 'dashed' } },
      { selector: '.faded', style: { opacity: 0.12 } },
      { selector: '.selected', style: { 'background-color': '#3794ff', 'border-color': '#9cdcfe', 'border-width': 2 } },
      { selector: '.sev-replace', style: { 'background-color': '#f14c4c', 'border-color': '#ff8787' } },
      { selector: '.sev-update', style: { 'background-color': '#cca700', 'border-color': '#e9d585' } },
      { selector: '.sev-noop', style: { 'background-color': '#3a3d41' } },
    ],
  });

  cy.on('tap', 'node', (evt) => selectNode(evt.target.id()));
  cy.on('tap', (evt) => {
    if (evt.target === cy) clearSelection();
  });

  setBanner(g.warnings && g.warnings.length ? g.warnings.join(' • ') : '');
}

function clearClasses(): void {
  if (!cy) return;
  cy.elements().removeClass('faded selected sev-replace sev-update sev-noop');
}

function clearSelection(): void {
  selectedId = undefined;
  clearClasses();
  setSeveritySource('');
}

function severityClass(s: Severity): string {
  if (s === 'replace' || s === 'destroy') return 'sev-replace';
  if (s === 'update') return 'sev-update';
  return 'sev-noop';
}

function selectNode(id: string): void {
  if (!cy || !graph) return;
  selectedId = id;
  clearClasses();

  const impacted = reachable(graph, id, direction);

  // Fade everything not in {selected} ∪ impacted.
  cy.nodes().forEach((n) => {
    const nid = n.id();
    if (nid !== id && !impacted.has(nid)) n.addClass('faded');
  });
  cy.edges().forEach((e) => {
    const s = e.source().id();
    const t = e.target().id();
    const inSet = (x: string) => x === id || impacted.has(x);
    if (!(inSet(s) && inSet(t))) e.addClass('faded');
  });

  cy.getElementById(id).addClass('selected');

  // Severity coloring. Only meaningful for the "dependents" question.
  if (direction === 'dependents') {
    const havePlan = Object.keys(planSeverity).length > 0;
    if (havePlan) {
      for (const nid of impacted) {
        const sev = planSeverity[nid];
        if (sev) cy.getElementById(nid).addClass(severityClass(sev));
      }
      setSeveritySource('severity: plan');
    } else {
      const est = estimateImpact(graph, id);
      for (const [nid, entry] of est) {
        cy.getElementById(nid).addClass(severityClass(entry.severity));
      }
      setSeveritySource('severity: estimate (run a plan for ground truth)');
    }
  } else {
    setSeveritySource('');
  }
}

function setBanner(text: string): void {
  const el = $('banner');
  if (text) {
    el.textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function setSeveritySource(text: string): void {
  $('severity-source').textContent = text;
}

// ---- wiring -----------------------------------------------------------------

function init(): void {
  $('fit').addEventListener('click', () => cy?.fit(undefined, 30));

  const toggle = $<HTMLInputElement>('direction-toggle');
  toggle.addEventListener('change', () => {
    direction = toggle.checked ? 'dependencies' : 'dependents';
    $('direction-label').textContent = toggle.checked
      ? 'Dependencies (what this needs)'
      : 'Dependents (what breaks)';
    if (selectedId) selectNode(selectedId);
  });

  $('run-plan').addEventListener('click', () => {
    vscodeApi.postMessage({ v: 1, type: 'command/run-plan' });
  });

  window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
    const msg = ev.data;
    if (!msg || msg.v !== 1) return;
    switch (msg.type) {
      case 'graph/loaded':
        $('source-label').textContent = msg.payload.sourceLabel;
        render(msg.payload.graph);
        break;
      case 'severity/result':
        planSeverity = msg.payload.severities;
        if (selectedId) selectNode(selectedId);
        break;
      case 'capabilities':
        $<HTMLButtonElement>('run-plan').disabled = !msg.payload.canRunPlan;
        break;
      case 'status':
        if (msg.payload.message) setBanner(msg.payload.message);
        break;
      case 'error':
        setBanner(msg.payload.message);
        break;
    }
  });

  vscodeApi.postMessage({ v: 1, type: 'ready' });

  // Debug handle (harmless in the sandboxed webview) so tests / a standalone
  // preview harness can drive selection exactly as a click would.
  (window as unknown as Record<string, unknown>).__blastRadius = {
    selectNode: (id: string) => selectNode(id),
    clear: () => clearSelection(),
    setDirection: (d: Direction) => {
      direction = d;
    },
    getCy: () => cy,
  };
}

init();
