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
  | 'breadth'
  // --- network / misconfiguration channel (Checkov, P2) ---
  | 'network_exposure' // SG/NACL open to 0.0.0.0/0 — reachable from untrusted origins
  | 'public_exposure' // resource made world-readable/-accessible (public S3, public RDS, public IP)
  | 'encryption' // data at rest / in transit not encrypted
  | 'misconfiguration' // generic failed IaC check, not otherwise classified
  // --- granted-vs-used lens (P2): a prioritization signal, not a new surface ---
  | 'unused_grant'; // granted but never invoked by the linked code

/** One normalized unit of security exposure, from any analyzer. */
export interface Finding {
  source: string; // adapter id, e.g. "cloudsplaining"
  channel: Channel;
  /** Stable identity of the thing the finding attaches to (policy/role/resource). */
  subject: string;
  category: RiskCategory;
  /** Specific action/port/etc. when applicable; "" for aggregate findings. */
  detail: string;
  /**
   * Granted-vs-used lens (P2): set when this finding's action is granted but
   * never invoked by the linked application code. NOT part of findingKey — the
   * diff identity is unchanged; this only re-weights the score (see score.ts,
   * UNUSED_MULTIPLIER) so a fix that grants unused high-risk actions ranks worse.
   */
  unused?: boolean;
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
    // Network / misconfiguration (Checkov). Calibrated to sit between IAM
    // `write` (10) and `permissions_management` (50): a single internet-open SG
    // or public bucket is comparable to a handful of risky IAM grants.
    public_exposure: 90, // world-readable data / publicly reachable resource
    network_exposure: 70, // SG/NACL open to 0.0.0.0/0
    encryption: 15, // unencrypted at rest
    misconfiguration: 5, // generic failed check
    // The unused-grant lens adds no surface of its own (the action is already
    // counted under `breadth` + its risk category); it re-weights those via
    // UNUSED_MULTIPLIER instead. Kept at 0 to avoid double-counting (PLAN.md §8).
    unused_grant: 0,
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
