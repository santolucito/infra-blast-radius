// Versioned, typed message protocol between the extension host and the webview.
// See DESIGN.md §2.6.

import { GraphData, Severity } from './graph/types';

export const PROTOCOL_VERSION = 1 as const;

export type Status = 'loading' | 'parsing' | 'ready';

// host -> webview
export type HostMessage =
  | { v: 1; type: 'graph/loaded'; payload: { graph: GraphData; sourceLabel: string } }
  | { v: 1; type: 'severity/result'; payload: { severities: Record<string, Severity>; source: 'plan' | 'estimate' } }
  | { v: 1; type: 'status'; payload: { status: Status; message?: string } }
  | { v: 1; type: 'error'; payload: { message: string } }
  | { v: 1; type: 'capabilities'; payload: { canRunPlan: boolean } };

// webview -> host
export type WebviewMessage =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'command/run-plan' };
