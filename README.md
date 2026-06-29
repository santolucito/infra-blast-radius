# Infrastructure Blast Radius

A VS Code extension that visualizes and **quantifies** the blast radius of a
CloudFormation or Terraform change *before* you deploy it. Select a resource and
see everything that transitively depends on it — and, on demand, how badly each
dependent is impacted (replace / update / no-op) from a real plan.

See [`DESIGN.md`](./DESIGN.md) for the full design.

## Features

- **CloudFormation** (`.yaml` / `.yml` / `.json`): parsed live from the editor
  buffer. Understands `Ref`, `Fn::GetAtt`, `Fn::Sub` interpolations, and
  `DependsOn`; filters out parameter/pseudo-parameter refs.
- **Terraform** (`.tf`): delegates to the `terraform` CLI (`terraform graph`),
  refreshed on save. Modules are flattened with cross-module edges preserved.
- **Blast-radius traversal**: cycle-safe; toggle between *dependents* ("what
  breaks if I change this") and *dependencies* ("what this needs").
- **Severity**:
  - *Plan-based* (Terraform): "Compute severity" runs `terraform plan` and colors
    nodes by real action.
  - *Edge-weighted estimate* (instant, no plan needed): colors by hard/soft
    dependency distance. Clearly labeled as an estimate.

## Develop

```bash
npm install
npm run compile      # bundle extension + webview (esbuild)
npm test             # parser + traversal unit tests (plain Node)
```

Press <kbd>F5</kbd> in VS Code ("Run Extension"), then open
`examples/cloudformation/network.yaml` (or run `terraform init` in
`examples/terraform/` first) and run **Visualize Blast Radius** from the command
palette or the editor title bar.

## Architecture (one screen)

```
Extension Host (Node)                         Webview (browser)
  provider detect ─┬─ CFN parser (buffer)      Cytoscape + dagre
                   └─ TF adapter (terraform)   blast-radius traversal (shared)
  severity engine (plan / change set)  ⇄ typed postMessage protocol ⇄
```

- Parsers (`src/parsers`) and traversal (`src/graph`) are pure and `vscode`-free,
  so they are unit-tested in plain Node.
- The same traversal code runs in the webview for instant selection feedback.

## Comparative security blast radius (`blast-compare`)

Beyond visualizing one change, the tool compares the **security** blast radius of
two alternative fixes and tells you which grants less access — see
[`PLAN.md`](./PLAN.md). It does **not** reimplement security analysis; it
orchestrates existing analyzers (P1: [Cloudsplaining](https://github.com/salesforce/cloudsplaining)),
normalizes their output, diffs two git refs, and scores the result.

```bash
# one-time: the offline IAM analyzer
pipx install cloudsplaining

npm run compile
node dist/cli.js \
  --repo /path/to/repo --base main \
  --a fix-broad --b fix-scoped \
  --target iam/ \
  [--weights examples/blast-radius.weights.json] [--max-delta 10] [--json]
```

Example output:

```
  baseline (main): score 1
  A (fix-broad)   score 2377  (+2376)  · 100 infra-mod, 56 write, 27 perms-mgmt, 2 service-wildcard …
  B (fix-scoped)  score 2     (+1)
  ✅ Smallest blast radius: B (fix-scoped) (1188.5× smaller than A)
```

`terraform plan` rates these two fixes identically (one IAM attachment each); the
security score does not. Weights are tunable (`--weights`); `--max-delta N` is an
opt-in CI gate. P1 extracts IAM policies from CloudFormation templates and bare
`.json` policy files (Terraform `jsonencode`/policy-document HCL is a follow-up).

## Status / scope

MVP. Plan-based severity is Terraform-only; CloudFormation severity (change sets)
is the next opt-in. Cross-stack `Fn::ImportValue` and remote state are out of
scope (see `DESIGN.md` §7).
