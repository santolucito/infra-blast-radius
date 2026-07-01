// Checkov adapter: runs the Checkov IaC misconfiguration scanner over a ref's
// worktree and normalizes its failed checks into Findings on the network/misconfig
// channel. Mirrors the Cloudsplaining adapter's shape and degrades gracefully when
// Checkov isn't installed (PLAN.md §3, §4, P2).
//
// Its categories (network_exposure / public_exposure / encryption /
// misconfiguration) live in src/compare/types.ts::RiskCategory, so analyze()
// returns plain Finding[] (CheckovFinding is an alias for Finding).

import { execFile } from 'child_process';
import { promisify } from 'util';
import { Finding } from '../types';
import {
  CheckovFailedCheck,
  CheckovFinding,
  normalizeCheckov,
} from '../checkov-normalize';
import { AnalysisContext, AnalyzerAdapter } from './types';

const execFileAsync = promisify(execFile);

export interface CheckovOptions {
  /** Path to the checkov executable. Defaults to "checkov" on PATH. */
  bin?: string;
  /** Extra args appended to the checkov invocation. */
  extraArgs?: string[];
  /** Per-invocation timeout (ms). Checkov can be slow on first run. */
  timeoutMs?: number;
}

/** Candidate checkov binaries, most-specific first. */
export function checkovCandidates(explicit?: string): string[] {
  const home = process.env.HOME ?? '';
  return [
    explicit ?? '',
    process.env.BLAST_CHECKOV ?? '',
    'checkov',
    home ? `${home}/.local/bin/checkov` : '',
  ].filter(Boolean);
}

async function checkovVersion(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** First checkov binary that responds to --version, or null. */
export async function resolveCheckov(explicit?: string): Promise<string | null> {
  for (const bin of checkovCandidates(explicit)) {
    if (await checkovVersion(bin)) return bin;
  }
  return null;
}

/**
 * Checkov exits non-zero (1) when it finds failed checks — that's the normal,
 * expected path, not an error. execFile rejects on non-zero, so we recover the
 * stdout off the rejection. Genuine failures (no stdout) re-throw.
 */
function parseCheckovJson(stdout: string): CheckovFailedCheck[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`checkov returned non-JSON: ${(e as Error).message}`);
  }
  // Checkov emits either one result object or an array of them (one per
  // framework, e.g. terraform + secrets). Collect failed_checks from all.
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const failed: CheckovFailedCheck[] = [];
  for (const b of blocks) {
    const checks = (b as any)?.results?.failed_checks;
    if (Array.isArray(checks)) failed.push(...checks);
  }
  return failed;
}

export class CheckovAdapter implements AnalyzerAdapter {
  readonly id = 'checkov';
  private bin: string | undefined;

  constructor(private readonly opts: CheckovOptions = {}) {
    this.bin = opts.bin;
  }

  async available(): Promise<boolean> {
    const bin = await resolveCheckov(this.bin);
    if (bin) this.bin = bin;
    return bin !== null;
  }

  /** Same widened result, exposed for the cross-channel demo / tests. */
  async analyzeRaw(ctx: AnalysisContext): Promise<CheckovFinding[]> {
    const bin = this.bin ?? (await resolveCheckov());
    if (!bin) throw new Error('checkov not found on PATH (pipx install checkov).');

    const args = [
      '-d',
      ctx.rootDir,
      '-o',
      'json',
      '--compact',
      '--quiet',
      ...(this.opts.extraArgs ?? []),
    ];

    let stdout: string;
    try {
      const r = await execFileAsync(bin, args, {
        timeout: this.opts.timeoutMs ?? 180_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      stdout = r.stdout;
    } catch (e: any) {
      // Exit code 1 == findings present: stdout still holds the JSON report.
      if (typeof e?.stdout === 'string' && e.stdout.trim()) {
        stdout = e.stdout;
      } else {
        throw new Error(`checkov failed: ${e?.stderr || e?.message || e}`);
      }
    }
    return normalizeCheckov(parseCheckovJson(stdout));
  }

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    return this.analyzeRaw(ctx);
  }
}
