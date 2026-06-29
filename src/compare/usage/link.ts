// Link application code directories to the IAM policy that governs them.
//
// The general problem (code → principal → resource) is hard: it needs to trace
// which deployed principal runs a given code artifact (a Lambda's package, an
// ECS task's image, an EC2 instance profile) and then which policies attach to
// that principal — across IaC, build pipelines, and runtime wiring. We do NOT
// solve that here. See INTEGRATION-grantused.md for the full discussion.
//
// The REQUIRED minimum is an explicit manifest the user maintains:
//
//   blast-usage.json  (at repo root):
//     { "<codeDir>": "<policyFile>", ... }
//
// where keys are code directories (relative to repo root) and values are the
// IAM policy source (a bare policy .json, or a CFN/SAM template — anything
// policy-extract.ts can read).
//
// As a BEST-EFFORT convenience we also infer links from SAM templates
// (AWS::Serverless::Function with CodeUri + inline Policies). This is
// approximate and clearly labeled; the manifest always wins.

import * as fs from 'fs';
import * as path from 'path';
import { loadTemplate } from '../../parsers/cloudformation';

export interface UsageLink {
  /** Code directory, relative to repo root. */
  codeDir: string;
  /** Policy source file, relative to repo root (file policy-extract can read). */
  policyFile: string;
  /** How the link was established. */
  via: 'manifest' | 'sam-inferred';
}

export const MANIFEST_NAME = 'blast-usage.json';

/**
 * Load links from `blast-usage.json` at `repoRoot`. Returns [] if absent.
 * Paths are normalized to be relative to repoRoot.
 */
export function loadManifestLinks(repoRoot: string): UsageLink[] {
  const file = path.join(repoRoot, MANIFEST_NAME);
  if (!fs.existsSync(file)) return [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${MANIFEST_NAME} is not valid JSON: ${(e as Error).message}`);
  }
  const out: UsageLink[] = [];
  for (const [codeDir, policyFile] of Object.entries(raw)) {
    if (typeof policyFile !== 'string') continue;
    out.push({ codeDir, policyFile, via: 'manifest' });
  }
  return out;
}

/**
 * Best-effort: infer links from SAM `AWS::Serverless::Function` resources that
 * declare both a `CodeUri` (the code dir) and inline `Policies` (in the same
 * template). The template file itself is used as the policy source, since
 * policy-extract.ts reads inline SAM/CFN policy documents from it.
 *
 * Limits: only same-template inline policies; does not resolve `Role:` ARNs,
 * managed-policy references, or cross-file roles. Approximate by design.
 */
export function inferSamLinks(repoRoot: string, templateFile: string): UsageLink[] {
  const abs = path.resolve(repoRoot, templateFile);
  let doc: any;
  try {
    doc = loadTemplate(fs.readFileSync(abs, 'utf8'));
  } catch {
    return [];
  }
  const resources = doc?.Resources;
  if (!resources || typeof resources !== 'object') return [];

  const rel = path.relative(repoRoot, abs);
  const out: UsageLink[] = [];
  for (const body of Object.values(resources as Record<string, any>)) {
    if (body?.Type !== 'AWS::Serverless::Function') continue;
    const codeUri = body?.Properties?.CodeUri;
    const policies = body?.Properties?.Policies;
    if (typeof codeUri !== 'string' || policies == null) continue;
    out.push({ codeDir: codeUri.replace(/\/+$/, ''), policyFile: rel, via: 'sam-inferred' });
  }
  return out;
}

/**
 * Resolve all links for a repo: manifest first (authoritative), optionally
 * augmented with SAM inference for code dirs the manifest doesn't already cover.
 */
export function resolveLinks(
  repoRoot: string,
  opts: { samTemplates?: string[] } = {},
): UsageLink[] {
  const links = loadManifestLinks(repoRoot);
  const covered = new Set(links.map((l) => path.normalize(l.codeDir)));
  for (const tpl of opts.samTemplates ?? []) {
    for (const inferred of inferSamLinks(repoRoot, tpl)) {
      if (!covered.has(path.normalize(inferred.codeDir))) {
        links.push(inferred);
        covered.add(path.normalize(inferred.codeDir));
      }
    }
  }
  return links;
}
