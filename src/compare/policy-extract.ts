// Tool-agnostic IAM policy extraction. Pulls IAM policy documents out of the
// inputs we can read statically (PLAN.md §7, P1):
//   - standalone IAM policy .json files
//   - CloudFormation templates (inline policies)
// Terraform inline jsonencode/data.aws_iam_policy_document needs HCL expression
// evaluation and is a documented follow-up (PLAN.md §8).

import * as fs from 'fs';
import * as path from 'path';
import { loadTemplate } from '../parsers/cloudformation';

export interface ExtractedPolicy {
  /** Stable identity used to diff the same policy across refs. */
  policyId: string;
  /** The IAM policy document (Version/Statement JSON). */
  document: unknown;
  sourceFile: string;
}

const CFN_EXTS = new Set(['.yaml', '.yml', '.json']);

function isPolicyDocument(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && 'Statement' in (v as Record<string, unknown>);
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (CFN_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

function extractFromCfn(doc: unknown, relFile: string, out: ExtractedPolicy[]): void {
  if (!doc || typeof doc !== 'object') return;
  const resources = (doc as Record<string, any>).Resources;
  if (!resources || typeof resources !== 'object') return;

  for (const [logicalId, body] of Object.entries(resources as Record<string, any>)) {
    if (!body || typeof body !== 'object') continue;
    const type: string = body.Type ?? '';
    const props = body.Properties ?? {};

    // AWS::IAM::Policy / ManagedPolicy -> Properties.PolicyDocument
    if (/^AWS::IAM::(Policy|ManagedPolicy)$/.test(type) && isPolicyDocument(props.PolicyDocument)) {
      out.push({
        policyId: `${relFile}#${logicalId}`,
        document: props.PolicyDocument,
        sourceFile: relFile,
      });
    }

    // AWS::IAM::Role/User/Group -> Properties.Policies[].PolicyDocument (inline)
    if (Array.isArray(props.Policies)) {
      props.Policies.forEach((p: any, i: number) => {
        if (isPolicyDocument(p?.PolicyDocument)) {
          const name = typeof p.PolicyName === 'string' ? p.PolicyName : String(i);
          out.push({
            policyId: `${relFile}#${logicalId}/${name}`,
            document: p.PolicyDocument,
            sourceFile: relFile,
          });
        }
      });
    }
  }
}

/**
 * Extract every IAM policy document under `rootDir` (optionally restricted to
 * `target`, a file or subdirectory). Paths in policyIds are relative to
 * `rootDir` so identities are stable across git-ref worktrees.
 */
export function extractPolicies(rootDir: string, target?: string): ExtractedPolicy[] {
  const base = target ? path.resolve(rootDir, target) : rootDir;
  const files: string[] = [];
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) walk(base, files);
  else if (CFN_EXTS.has(path.extname(base).toLowerCase())) files.push(base);

  const out: ExtractedPolicy[] = [];
  for (const file of files.sort()) {
    const rel = path.relative(rootDir, file) || path.basename(file);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let doc: unknown;
    try {
      doc = loadTemplate(raw);
    } catch {
      continue; // unparseable mid-edit / non-template file
    }
    if (isPolicyDocument(doc)) {
      // A bare IAM policy file.
      out.push({ policyId: rel, document: doc, sourceFile: rel });
    } else {
      extractFromCfn(doc, rel, out);
    }
  }
  return out;
}
