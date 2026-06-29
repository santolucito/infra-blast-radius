// Normalized comparison model. Heterogeneous analyzer outputs are normalized
// into Findings; Findings are scored and diffed across git refs. See PLAN.md §3.

export type Channel = 'iam' | 'network' | 'dependency';

export type RiskCategory =
  | 'privilege_escalation'
  | 'data_exfiltration'
  | 'credentials_exposure'
  | 'permissions_management'
  | 'write'
  | 'tagging'
  | 'infrastructure_modification'
  | 'service_wildcard'
  | 'breadth';

/** One normalized unit of security exposure, from any analyzer. */
export interface Finding {
  source: string; // adapter id, e.g. "cloudsplaining"
  channel: Channel;
  /** Stable identity of the thing the finding attaches to (policy/role/resource). */
  subject: string;
  category: RiskCategory;
  /** Specific action/port/etc. when applicable; "" for aggregate findings. */
  detail: string;
}

/** A stable key for set-diffing findings across refs. */
export function findingKey(f: Finding): string {
  return `${f.source}|${f.channel}|${f.subject}|${f.category}|${f.detail}`;
}

export interface AnalysisResult {
  ref: string;
  findings: Finding[];
}

export interface Weights {
  /** Per category weight. `breadth` is per allowed-action. */
  category: Record<RiskCategory, number>;
}

export const DEFAULT_WEIGHTS: Weights = {
  category: {
    breadth: 1,
    privilege_escalation: 80,
    credentials_exposure: 60,
    permissions_management: 50,
    data_exfiltration: 40,
    write: 10,
    service_wildcard: 100,
    tagging: 2,
    // Overlaps with write/permissions_management; kept informational to avoid
    // double-counting in the score (PLAN.md §8).
    infrastructure_modification: 0,
  },
};

export interface ScoredRef {
  ref: string;
  score: number;
  byCategory: Record<string, number>;
  findingCount: number;
}

export interface RefDiff {
  ref: string;
  added: Finding[]; // present in this ref, absent in baseline
  removed: Finding[]; // present in baseline, absent in this ref
}

export interface Comparison {
  baseline: ScoredRef;
  candidates: Array<{
    scored: ScoredRef;
    diff: RefDiff;
    deltaVsBaseline: number; // candidate.score - baseline.score
  }>;
  /** ref name of the lowest-scoring candidate (smallest blast radius). */
  winner: string | null;
}
