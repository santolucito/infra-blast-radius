// Normalize Cloudsplaining shim output into the common Finding model.
// Pure + tested: this is the boundary where one tool's vocabulary becomes ours.

import { Finding, RiskCategory } from './types';

export interface CloudsplainingSummary {
  policyId: string;
  allowedActions: string[];
  serviceWildcards: string[];
  risks: Partial<Record<Exclude<RiskCategory, 'breadth' | 'service_wildcard'>, string[]>>;
  error?: string;
}

const SOURCE = 'cloudsplaining';

export function normalizeCloudsplaining(summaries: CloudsplainingSummary[]): Finding[] {
  const out: Finding[] = [];
  for (const s of summaries) {
    if (s.error) continue;
    const subject = s.policyId;

    // Base attack surface: every action the policy allows.
    for (const action of s.allowedActions ?? []) {
      out.push({ source: SOURCE, channel: 'iam', subject, category: 'breadth', detail: action });
    }

    // Wildcarded whole services (breadth multiplier in spirit; scored separately).
    for (const svc of s.serviceWildcards ?? []) {
      out.push({ source: SOURCE, channel: 'iam', subject, category: 'service_wildcard', detail: svc });
    }

    // Risk premiums: unconstrained risky actions, per category.
    for (const [category, actions] of Object.entries(s.risks ?? {})) {
      for (const detail of actions ?? []) {
        out.push({
          source: SOURCE,
          channel: 'iam',
          subject,
          category: category as RiskCategory,
          detail,
        });
      }
    }
  }
  return out;
}
