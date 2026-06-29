import * as path from 'path';
import * as vscode from 'vscode';
import { GraphData, Severity } from './graph/types';
import { parseCloudFormation, looksLikeCloudFormation } from './parsers/cloudformation';
import {
  isTerraformAvailable,
  runTerraformGraph,
  runTerraformPlanSeverity,
} from './parsers/terraform';
import { estimateImpact } from './graph/traversal';
import { BlastRadiusPanel } from './panel';

type Provider = 'terraform' | 'cloudformation';

interface ActiveSource {
  provider: Provider;
  /** For TF: the workspace dir. For CFN: the document uri. */
  uri: vscode.Uri;
  cwd?: string; // TF working dir
  label: string;
  graph: GraphData;
}

let active: ActiveSource | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('infra-blast-radius.visualize', () =>
      visualize(context).catch((e) =>
        vscode.window.showErrorMessage(`Blast Radius: ${(e as Error).message}`)
      )
    )
  );

  // Save-triggered Terraform refresh (DESIGN.md §2.4).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const cfg = vscode.workspace.getConfiguration('infraBlastRadius');
      if (!cfg.get<boolean>('terraform.autoRefreshOnSave', true)) return;
      if (
        active?.provider === 'terraform' &&
        doc.languageId === 'terraform' &&
        BlastRadiusPanel.current
      ) {
        await refreshTerraform(BlastRadiusPanel.current).catch(() => undefined);
      }
    })
  );

  // CloudFormation is live: re-parse the buffer as it changes (debounced).
  let debounce: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (active?.provider !== 'cloudformation') return;
      if (e.document.uri.toString() !== active.uri.toString()) return;
      if (!BlastRadiusPanel.current) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        reparseCloudFormation(BlastRadiusPanel.current!, e.document);
      }, 300);
    })
  );
}

export function deactivate(): void {
  /* no-op */
}

async function visualize(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a Terraform or CloudFormation file first.');
    return;
  }
  const doc = editor.document;
  const provider = await detectProvider(doc);
  if (!provider) {
    vscode.window.showWarningMessage(
      'Could not detect a Terraform (.tf) or CloudFormation template in the active editor.'
    );
    return;
  }

  const panel = BlastRadiusPanel.createOrShow(context.extensionUri);
  panel.setHandlers({
    onReady: () => sendCurrent(panel),
    onRunPlan: () => computeSeverity(panel).catch((e) =>
      panel.error(`Severity failed: ${(e as Error).message}`)
    ),
  });
  panel.reveal();
  panel.setStatus('parsing');

  if (provider === 'cloudformation') {
    const graph = parseCloudFormation(doc.getText());
    active = {
      provider,
      uri: doc.uri,
      label: path.basename(doc.fileName),
      graph,
    };
    panel.setCapabilities(false); // CFN severity via change set = future opt-in
  } else {
    const cwd = path.dirname(doc.uri.fsPath);
    const bin = vscode.workspace
      .getConfiguration('infraBlastRadius')
      .get<string>('terraform.path', 'terraform');
    const available = await isTerraformAvailable(bin);
    let graph: GraphData;
    if (available) {
      try {
        graph = await runTerraformGraph({ bin, cwd });
      } catch (e) {
        graph = { schemaVersion: 1, provider, nodes: [], edges: [], warnings: [
          `terraform graph failed (is the workspace initialized? run "terraform init"): ${(e as Error).message}`,
        ] };
      }
    } else {
      graph = { schemaVersion: 1, provider, nodes: [], edges: [], warnings: [
        `terraform executable not found at "${bin}". Set infraBlastRadius.terraform.path.`,
      ] };
    }
    active = { provider, uri: doc.uri, cwd, label: path.basename(cwd), graph };
    panel.setCapabilities(available && graph.nodes.length > 0);
  }

  sendCurrent(panel);
}

function sendCurrent(panel: BlastRadiusPanel): void {
  if (!active) return;
  panel.loadGraph(active.graph, active.label);
  panel.setStatus('ready');
}

function reparseCloudFormation(panel: BlastRadiusPanel, doc: vscode.TextDocument): void {
  if (!active) return;
  const graph = parseCloudFormation(doc.getText());
  // Keep last good graph if the buffer is mid-edit and yields nothing.
  if (graph.nodes.length === 0 && graph.warnings.length > 0 && active.graph.nodes.length > 0) {
    panel.setStatus('ready', `stale — ${graph.warnings[0]}`);
    return;
  }
  active.graph = graph;
  sendCurrent(panel);
}

async function refreshTerraform(panel: BlastRadiusPanel): Promise<void> {
  if (active?.provider !== 'terraform' || !active.cwd) return;
  const bin = vscode.workspace
    .getConfiguration('infraBlastRadius')
    .get<string>('terraform.path', 'terraform');
  panel.setStatus('parsing', 're-running terraform graph…');
  active.graph = await runTerraformGraph({ bin, cwd: active.cwd });
  sendCurrent(panel);
}

async function computeSeverity(panel: BlastRadiusPanel): Promise<void> {
  if (!active) return;
  if (active.provider === 'terraform' && active.cwd) {
    const bin = vscode.workspace
      .getConfiguration('infraBlastRadius')
      .get<string>('terraform.path', 'terraform');
    panel.setStatus('loading', 'running terraform plan…');
    const sev = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Blast Radius: terraform plan' },
      () => runTerraformPlanSeverity({ bin, cwd: active!.cwd! })
    );
    const severities: Record<string, Severity> = {};
    for (const [k, v] of sev) severities[k] = v;
    panel.post({ v: 1, type: 'severity/result', payload: { severities, source: 'plan' } });
    panel.setStatus('ready');
  } else {
    // CFN MVP: no change-set integration — webview falls back to the local
    // edge-weighted estimate on selection. Nothing to push here.
    panel.error('Plan-based severity is available for Terraform only in this version.');
  }
}

async function detectProvider(doc: vscode.TextDocument): Promise<Provider | undefined> {
  const ext = path.extname(doc.fileName).toLowerCase();
  if (ext === '.tf' || doc.languageId === 'terraform') return 'terraform';
  if (['.yaml', '.yml', '.json'].includes(ext)) {
    return looksLikeCloudFormation(doc.getText()) ? 'cloudformation' : undefined;
  }
  return undefined;
}

// Re-exported for tests / external use of the estimate (DESIGN.md §5.2).
export { estimateImpact };
