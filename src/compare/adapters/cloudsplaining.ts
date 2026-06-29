// Cloudsplaining adapter: feeds extracted policies to the Python shim and
// normalizes the result. Degrades gracefully when the tool isn't installed.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Finding } from '../types';
import { CloudsplainingSummary, normalizeCloudsplaining } from '../normalize';
import { AnalysisContext, AnalyzerAdapter } from './types';

const execFileAsync = promisify(execFile);

export interface CloudsplainingOptions {
  /** Python interpreter that can `import cloudsplaining`. */
  python?: string;
  /** Path to cloudsplaining_shim.py. */
  shimPath: string;
}

/** Candidate interpreters, most-specific first. */
export function pythonCandidates(): string[] {
  const home = os.homedir();
  return [
    process.env.BLAST_PYTHON ?? '',
    path.join(home, '.local/pipx/venvs/cloudsplaining/bin/python'),
    'python3',
    'python',
  ].filter(Boolean);
}

/** Run a command, write `input` to stdin, resolve stdout (reject on non-zero). */
function runWithStdin(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function importsCloudsplaining(py: string): Promise<boolean> {
  try {
    await execFileAsync(py, ['-c', 'import cloudsplaining'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** First interpreter that can import cloudsplaining, or null. */
export async function resolvePython(explicit?: string): Promise<string | null> {
  const candidates = explicit ? [explicit, ...pythonCandidates()] : pythonCandidates();
  for (const py of candidates) {
    if (await importsCloudsplaining(py)) return py;
  }
  return null;
}

export class CloudsplainingAdapter implements AnalyzerAdapter {
  readonly id = 'cloudsplaining';
  private python: string | undefined;

  constructor(private readonly opts: CloudsplainingOptions) {
    this.python = opts.python;
  }

  async available(): Promise<boolean> {
    const py = await resolvePython(this.python);
    if (py) this.python = py;
    return py !== null && fs.existsSync(this.opts.shimPath);
  }

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    if (ctx.policies.length === 0) return [];
    const py = this.python ?? (await resolvePython());
    if (!py) throw new Error('No Python interpreter with cloudsplaining found.');

    const descriptors = ctx.policies.map((p) => ({ policyId: p.policyId, document: p.document }));
    const stdout = await runWithStdin(py, [this.opts.shimPath], JSON.stringify(descriptors));

    let summaries: CloudsplainingSummary[];
    try {
      summaries = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`cloudsplaining shim returned non-JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(summaries)) {
      throw new Error(`cloudsplaining shim error: ${JSON.stringify(summaries)}`);
    }
    return normalizeCloudsplaining(summaries);
  }
}
