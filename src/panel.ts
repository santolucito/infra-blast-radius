// Webview panel wrapper: secure HTML shell (CSP + nonce), resource URIs, and the
// typed message bridge. See DESIGN.md §2.5 / §2.6.

import * as vscode from 'vscode';
import { GraphData } from './graph/types';
import { HostMessage, WebviewMessage } from './protocol';

export class BlastRadiusPanel {
  public static current: BlastRadiusPanel | undefined;
  private static readonly viewType = 'infraBlastRadius.graph';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private onRunPlan?: () => void;
  private onReady?: () => void;

  static createOrShow(extensionUri: vscode.Uri): BlastRadiusPanel {
    const column = vscode.ViewColumn.Beside;
    if (BlastRadiusPanel.current) {
      BlastRadiusPanel.current.panel.reveal(column);
      return BlastRadiusPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      BlastRadiusPanel.viewType,
      'Blast Radius',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    BlastRadiusPanel.current = new BlastRadiusPanel(panel, extensionUri);
    return BlastRadiusPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        if (!msg || msg.v !== 1) return;
        if (msg.type === 'ready') this.onReady?.();
        else if (msg.type === 'command/run-plan') this.onRunPlan?.();
      },
      null,
      this.disposables
    );
  }

  setHandlers(handlers: { onReady?: () => void; onRunPlan?: () => void }): void {
    this.onReady = handlers.onReady;
    this.onRunPlan = handlers.onRunPlan;
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  // convenience senders
  loadGraph(graph: GraphData, sourceLabel: string): void {
    this.post({ v: 1, type: 'graph/loaded', payload: { graph, sourceLabel } });
  }
  setStatus(status: 'loading' | 'parsing' | 'ready', message?: string): void {
    this.post({ v: 1, type: 'status', payload: { status, message } });
  }
  error(message: string): void {
    this.post({ v: 1, type: 'error', payload: { message } });
  }
  setCapabilities(canRunPlan: boolean): void {
    this.post({ v: 1, type: 'capabilities', payload: { canRunPlan } });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  dispose(): void {
    BlastRadiusPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css')
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Blast Radius</title>
</head>
<body>
  <div id="toolbar">
    <span id="source-label"></span>
    <span class="spacer"></span>
    <label class="toggle">
      <input type="checkbox" id="direction-toggle" />
      <span id="direction-label">Dependents (what breaks)</span>
    </label>
    <button id="run-plan" title="Run a real plan / change set for accurate severity">Compute severity</button>
    <button id="fit">Fit</button>
  </div>
  <div id="banner" class="hidden"></div>
  <div id="cy"></div>
  <div id="legend">
    <span class="sev replace">replace / destroy</span>
    <span class="sev update">update</span>
    <span class="sev noop">no-op</span>
    <span class="sev selected">selected</span>
    <span id="severity-source"></span>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
