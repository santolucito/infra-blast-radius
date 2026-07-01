// Git-ref orchestrator: check out the baseline and each candidate ref in
// isolated worktrees, extract policies, run the adapters, and assemble a scored
// comparison. Enforces the same-baseline guarantee (PLAN.md §4, §8).

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { buildComparison } from './diff';
import { extractPolicies } from './policy-extract';
import { AnalysisResult, Comparison, Finding, Weights } from './types';
import { AnalysisContext, AnalyzerAdapter } from './adapters/types';
import { applyUsageLens } from './usage/postprocess';
import { applyPrincipalReach } from './principals';

const execFileAsync = promisify(execFile);

export interface CompareOptions {
  repoDir: string;
  baseRef: string;
  candidateRefs: string[];
  target?: string;
  adapters: AnalyzerAdapter[];
  weights: Weights;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function analyzeRef(
  opts: CompareOptions,
  ref: string,
  adapters: AnalyzerAdapter[]
): Promise<AnalysisResult> {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-wt-'));
  try {
    await git(opts.repoDir, ['worktree', 'add', '--detach', '--force', worktree, ref]);
    const policies = extractPolicies(worktree, opts.target);
    const ctx: AnalysisContext = { rootDir: worktree, policies };

    const findings: Finding[] = [];
    for (const a of adapters) {
      findings.push(...(await a.analyze(ctx)));
    }
    // Granted-vs-used lens (P2): mark findings whose action the linked code never
    // calls. No-op unless the worktree has a blast-usage.json manifest. Reuses the
    // findings just produced — no second analyzer run.
    const lensed = applyUsageLens(findings, worktree);
    // Principal reach (P2): scale a policy's findings by how many principals carry
    // it (from the CFN attachment graph). No-op for dedicated / bare-file policies.
    const reached = applyPrincipalReach(lensed.findings, policies);
    return { ref, findings: reached };
  } finally {
    await git(opts.repoDir, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

export async function compareRefs(opts: CompareOptions): Promise<Comparison> {
  // Only use adapters that are actually available; surface which ran.
  const adapters: AnalyzerAdapter[] = [];
  for (const a of opts.adapters) {
    if (await a.available()) adapters.push(a);
  }
  if (adapters.length === 0) {
    throw new Error('No analyzer adapters are available (is cloudsplaining installed?).');
  }

  const baseline = await analyzeRef(opts, opts.baseRef, adapters);
  const candidates: AnalysisResult[] = [];
  for (const ref of opts.candidateRefs) {
    candidates.push(await analyzeRef(opts, ref, adapters));
  }
  return buildComparison(baseline, candidates, opts.weights);
}
