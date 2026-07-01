// CLI frontend: compare the security blast radius of two (or more) git refs.
//
//   blast-compare --repo . --base main --a fix-broad --b fix-scoped --target iam/
//
// Prints a ranked verdict. Use --json for machine output (CI).

import * as fs from 'fs';
import * as path from 'path';
import { CloudsplainingAdapter } from './adapters/cloudsplaining';
import { CheckovAdapter } from './adapters/checkov';
import { AnalyzerAdapter } from './adapters/types';
import { compareRefs } from './orchestrator';
import { resolveWeights } from './score';
import { Comparison, Weights } from './types';

interface Args {
  repo: string;
  base?: string;
  candidates: Array<{ name: string; ref: string }>;
  target?: string;
  python?: string;
  weights?: string;
  json: boolean;
  maxDelta?: number;
  noCheckov: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repo: '.', candidates: [], json: false, noCheckov: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--repo': args.repo = next(); break;
      case '--base': args.base = next(); break;
      case '--target': args.target = next(); break;
      case '--python': args.python = next(); break;
      case '--weights': args.weights = next(); break;
      case '--max-delta': args.maxDelta = Number(next()); break;
      case '--no-checkov': args.noCheckov = true; break;
      case '--json': args.json = true; break;
      case '--a': args.candidates.push({ name: 'A', ref: next() }); break;
      case '--b': args.candidates.push({ name: 'B', ref: next() }); break;
      case '--c': args.candidates.push({ name: 'C', ref: next() }); break;
      default:
        if (a.startsWith('--ref:')) args.candidates.push({ name: a.slice(6), ref: next() });
        break;
    }
  }
  return args;
}

function resolveShim(): string {
  const candidates = [
    path.join(__dirname, 'cloudsplaining_shim.py'), // bundled (dist/)
    path.join(__dirname, 'adapters', 'cloudsplaining_shim.py'),
    path.join(__dirname, '..', '..', '..', 'src', 'compare', 'adapters', 'cloudsplaining_shim.py'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function loadWeights(file?: string): Weights {
  if (!file) return resolveWeights();
  const partial = JSON.parse(fs.readFileSync(file, 'utf8'));
  return resolveWeights(partial);
}

function tallyCategories(findings: { category: string }[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const f of findings) t[f.category] = (t[f.category] ?? 0) + 1;
  return t;
}

function printHuman(cmp: Comparison, names: Map<string, string>): void {
  const label = (ref: string) => `${names.get(ref) ?? ''} (${ref})`.trim();
  console.log('\n  Security Blast Radius — comparison\n  ' + '─'.repeat(46));
  console.log(`  baseline ${label(cmp.baseline.ref)}: score ${cmp.baseline.score}`);
  console.log('');

  for (const c of cmp.candidates) {
    const sign = c.deltaVsBaseline >= 0 ? '+' : '';
    console.log(`  ${label(c.scored.ref)}`);
    console.log(`    score ${c.scored.score}  (${sign}${c.deltaVsBaseline} vs baseline)`);
    const addTally = tallyCategories(c.diff.added);
    const unused = addTally['unused_grant'] ?? 0;
    const interesting = Object.entries(addTally)
      .filter(([k]) => k !== 'breadth' && k !== 'unused_grant')
      .sort((a, b) => b[1] - a[1]);
    if (c.diff.added.length) {
      const breadth = addTally['breadth'] ?? 0;
      // unused_grant entries are weight-0 explanatory markers, not new surface.
      const realCount = c.diff.added.length - unused;
      console.log(`    adds ${realCount} findings (${breadth} new allowed actions)`);
      for (const [cat, n] of interesting) console.log(`      • ${cat}: ${n}`);
      if (unused) console.log(`      • unused grants (granted, never called by linked code): ${unused}`);
      const reaches = [...new Set(
        c.diff.added.map((f) => f.reachFactor).filter((n): n is number => !!n && n > 1)
      )].sort((a, b) => a - b);
      if (reaches.length) {
        console.log(`      • shared-role reach: ×${reaches.join(', ×')} (grant lands on multiple principals)`);
      }
    }
    if (c.diff.removed.length) console.log(`    removes ${c.diff.removed.length} findings`);
    console.log('');
  }

  if (cmp.winner) {
    const w = cmp.candidates.find((c) => c.scored.ref === cmp.winner)!;
    const others = cmp.candidates.filter((c) => c.scored.ref !== cmp.winner);
    const factor =
      others.length === 1 && w.scored.score > 0
        ? ` (${(others[0].scored.score / w.scored.score).toFixed(1)}× smaller than ${label(others[0].scored.ref)})`
        : '';
    console.log(`  ✅ Smallest blast radius: ${label(cmp.winner)}${factor}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || args.candidates.length === 0) {
    console.error('usage: blast-compare --repo <dir> --base <ref> --a <ref> [--b <ref>] [--target <path>] [--weights f.json] [--json]');
    process.exit(2);
  }

  const repo = path.resolve(args.repo);
  const names = new Map<string, string>();
  for (const c of args.candidates) names.set(c.ref, c.name);

  // Cloudsplaining (IAM) is the core analyzer and is required. Checkov
  // (network/misconfig) is additive and optional — included when installed
  // unless --no-checkov. The orchestrator filters to available adapters too.
  const adapters: AnalyzerAdapter[] = [];
  const cloudsplaining = new CloudsplainingAdapter({ python: args.python, shimPath: resolveShim() });
  if (!(await cloudsplaining.available())) {
    console.error('cloudsplaining not available. Install with: pipx install cloudsplaining');
    console.error('(or pass --python <interpreter that can import cloudsplaining>)');
    process.exit(3);
  }
  adapters.push(cloudsplaining);

  if (!args.noCheckov) {
    const checkov = new CheckovAdapter();
    if (await checkov.available()) adapters.push(checkov);
    else if (!args.json) {
      console.error('  (note: checkov not found — IAM-only analysis. `pipx install checkov` for network/misconfig.)');
    }
  }
  if (!args.json) console.error(`  analyzers: ${adapters.map((a) => a.id).join(', ')}`);

  const cmp = await compareRefs({
    repoDir: repo,
    baseRef: args.base,
    candidateRefs: args.candidates.map((c) => c.ref),
    target: args.target,
    adapters,
    weights: loadWeights(args.weights),
  });

  if (args.json) console.log(JSON.stringify(cmp, null, 2));
  else printHuman(cmp, names);

  // Optional CI gate: fail if the BEST candidate still adds more than --max-delta
  // over the baseline (i.e. even the safest option is too costly). Opt-in; a
  // successful comparison otherwise exits 0, since adding access is expected.
  if (args.maxDelta !== undefined && cmp.winner) {
    const w = cmp.candidates.find((c) => c.scored.ref === cmp.winner)!;
    if (w.deltaVsBaseline > args.maxDelta) {
      console.error(`  ✗ gate: best option ${cmp.winner} adds ${w.deltaVsBaseline} > --max-delta ${args.maxDelta}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`blast-compare: ${(e as Error).message}`);
  process.exit(10);
});
