# Security Blast Radius

[![CI](https://github.com/santolucito/infra-blast-radius/actions/workflows/ci.yml/badge.svg)](https://github.com/santolucito/infra-blast-radius/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Compare two infrastructure changes and see which one has the smaller _security_
blast radius — and why.**

When you have two ways to fix a security finding — an over-permissioned role, an
open port — which is safer? `terraform plan` shows both as "1 policy changed";
security scanners rate one state at a time and never compare two. This tool answers
the question a reviewer actually has at merge time: **given fix-A and fix-B, which
grants less access, and what specifically drove the difference?**

It does **not** reimplement security analysis. It orchestrates existing analyzers,
normalizes their output into one model, diffs two git refs, and scores the result.
The novel layer is the _comparison_ — see [`PLAN.md`](./PLAN.md) for the full design.

```
$ blast-compare --repo . --base main --ref:A fix-A --ref:B fix-B
  analyzers: cloudsplaining, checkov

  A (fix-A)   score 617   (network exposure: 5 · public exposure: 1)
  B (fix-B)   score 180
  ✅ Smallest blast radius: B (fix-B) — 3.4× smaller than A
```

## What it looks at

Each analyzer is optional and used when installed; findings are keyed by
`source + channel` so they merge into one comparable score without double-counting.

| Analyzer | Channel | What it contributes |
|---|---|---|
| [Cloudsplaining](https://github.com/salesforce/cloudsplaining) | `iam` | IAM action risk — priv-esc, data-exfil, perms-mgmt; wildcard/resource aware |
| [Checkov](https://www.checkov.io/) | `network` | IaC misconfiguration — open SGs, public buckets, missing encryption |
| granted-vs-used (built in) | `iam` | static AWS-SDK scan flags grants the app code never calls |
| principal reach (built in) | `iam` | a grant on a role shared by _N_ principals scores _N×_ |

## Quick start

```bash
# analyzers (both optional; Cloudsplaining is the core)
pipx install cloudsplaining checkov

npm install
npm run compile          # build dist/cli.js
npm test                 # 52 unit tests, no external tools required
```

**CLI:**

```bash
node dist/cli.js --repo /path/to/repo --base main --ref:A fix-A --ref:B fix-B \
  [--target iam/] [--no-checkov] [--weights weights.json] [--max-delta 10] [--json]
```

**Interactive web UI** — an infra visualizer + a live comparison panel, every
number from a real CLI run (see [`web/README.md`](./web/README.md)):

```bash
npm run web              # -> http://localhost:4173
```

## Worked examples

Reproducible, each with a `build-repo.sh` and expected output:

| [`examples/`](./examples) | The decision |
|---|---|
| [`tradeoff`](./examples/tradeoff) | tighter IAM vs. an open network — no obvious winner; the verdict is a tunable threat-model choice |
| [`shared-role`](./examples/shared-role) | dedicated least-privilege role vs. reusing the broad shared role |
| [`shared-reach`](./examples/shared-reach) | the _same_ grant costs 6× on a role shared by 6 services |

```bash
DEST=$(examples/tradeoff/build-repo.sh)
node dist/cli.js --repo "$DEST" --base main --ref:A fix-A --ref:B fix-B
```

A slide deck introducing the tool from zero is in
[`slides/team-intro.html`](./slides/team-intro.html) (open in any browser).

## How it works

```
git refs: baseline, fix-A, fix-B
   │  (isolated worktree per ref)
   ▼
 ANALYZER ADAPTERS   Cloudsplaining → JSON   Checkov → JSON
   ▼
 NORMALIZE → one Finding model  → granted-vs-used lens + principal reach
   ▼
 DIFF each fix vs baseline → SCORE (reach × sensitivity, tunable weights) → VERDICT
```

- `src/compare` — the comparison engine (adapters, normalize, diff, score,
  orchestrator, CLI). Pure and `vscode`-free; unit-tested in plain Node.
- `web` — the local web front-end (Node `http`, zero extra deps).
- Scoring is `reach × sensitivity` with tunable weights; the verdict always shows
  the drivers, never just the number. Boundaries are documented in `PLAN.md` §8.

## How this differs from other "blast radius" tools

| Tool | What it shows | Answers |
|---|---|---|
| [Blast Radius (28mm)](https://github.com/28mm/blast-radius) · `terraform graph` | the dependency graph of **one** state — what resources connect | "what depends on this resource?" |
| `terraform plan` | what a single change adds / updates / destroys | "what does this change touch?" |
| **this tool** | who can reach/act on what, **diffed across two git refs** | "which of these two fixes grants less access, and why?" |

The existing _Blast Radius_ is **descriptive** and **dependency**-oriented: it
renders what depends on what in a single configuration (a _change_ blast radius).
This tool is **comparative** and **security**-oriented: it scores who-can-reach-what
across two refs and returns a ranked verdict with the drivers, not a picture. (The
dependency visualizer below is in that same descriptive category — which is exactly
why the product is the comparative security layer built on top of it.)

## Also in this repo: the dependency-radius visualizer

The engine grew out of a VS Code extension that visualizes the _change_ blast
radius of a single CloudFormation/Terraform edit (what transitively depends on a
resource, colored by `terraform plan` severity). It's the substrate the security
tool was built on; see [`DESIGN.md`](./DESIGN.md). Press <kbd>F5</kbd> in VS Code
("Run Extension") and run **Visualize Blast Radius** on
`examples/cloudformation/network.yaml`.

## License

[MIT](./LICENSE)
