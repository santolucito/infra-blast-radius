import { Finding } from '../types';
import { ExtractedPolicy } from '../policy-extract';

/** Shared, tool-agnostic context for one ref's worktree. */
export interface AnalysisContext {
  /** Absolute path to the checked-out worktree for this ref. */
  rootDir: string;
  /** IAM policies extracted from the config (tool-agnostic, computed once). */
  policies: ExtractedPolicy[];
}

/**
 * Pluggable analyzer. Each external tool sits behind this single interface, so
 * adding/swapping a tool is an isolated, tested unit (PLAN.md §4).
 */
export interface AnalyzerAdapter {
  id: string;
  /** Is the tool installed / are required creds present? */
  available(): Promise<boolean>;
  /** Run the tool over the context and return normalized findings. */
  analyze(ctx: AnalysisContext): Promise<Finding[]>;
}
