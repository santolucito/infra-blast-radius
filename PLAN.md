# Plan: Comparative **Security** Blast Radius

> A decision-support tool that compares two alternative infrastructure changes
> and tells you which has the smaller **security** blast radius — and why.
>
> **Posture: we do not build security analysis. We orchestrate existing
> analyzers, normalize their output, diff two git refs, and score the result.**
> The novel layer is the *comparison*, not the analysis.
>
> Builds on the engine in this repo (parsers → normalized graph → traversal),
> which becomes the substrate. `DESIGN.md` (describe one change) is superseded.

---

## 1. Why this, and why it's different

Two realizations reframed the project:

1. **The interesting question is comparative, not descriptive.** `terraform
   plan`, `terraform graph`, and every viz tool (including the original
   [Blast Radius](https://github.com/28mm/blast-radius)) describe *one* state.
   None answer *"I have two ways to fix this — which is safer?"* That needs a
   metric and an A/B diff, which nothing provides.

2. **The valuable sense of "blast radius" is security, not change** — and the
   security analysis already exists in mature tools. So the work is *combining
   and comparing*, not analyzing.

### The motivating example

A Lambda needs to read one S3 bucket. Two fixes:

| | Fix A | Fix B |
|---|---|---|
| Change | attach `AmazonS3FullAccess` | inline `s3:GetObject` on `arn:…:my-bucket/*` |
| Terraform *change* blast radius | identical (1 IAM attachment) | identical (1 IAM attachment) |
| **Security blast radius** | **~100 actions across *every* bucket incl. delete** | **1 action, 1 bucket** |

`terraform plan` rates these the same. The product says *"Fix A exposes 8,400×
more — choose B,"* and shows the grants that drove it. That gap is the whole tool.

---

## 2. What "security blast radius" means

> **How much a change expands `reach × sensitivity`** — the set of
> `(principal → action → resource)` capabilities and network exposure it newly
> enables, weighted by how sensitive the reached resources are.

It's a **reachability** question over an **access graph** (who can reach/act on
what), not the dependency graph (who consumes whose values). Two channels:

- **Identity/permission reach** — effective `{action, resource}` per principal,
  expanding managed policies, wildcards, and (later) assume-role chains.
- **Network exposure reach** — resources reachable from untrusted origins via
  public IP + permissive SG/NACL + route.

A fix's blast radius is the set it **newly enables** vs. baseline. Reachability is
a sound upper bound on what an attacker could touch, so over-approximation is the
safe direction.

**Crucially, this is mostly static** — computable from parsed config, no
credentials or `terraform apply` for the offline path. So it runs on uncommitted
edits and in CI, and comparing two git refs is just "analyze each, diff."

---

## 3. The core posture: outsource analysis, own the comparison

The security primitives are mature, mostly OSS, mostly JSON-emitting. We consume
them; we do not reimplement them.

### What we outsource

| Capability | Outsource to | Interface | Creds? |
|---|---|---|---|
| IAM action risk classification (read / write / perms-mgmt / data-exfil / priv-esc) | **Cloudsplaining**, **policy_sentry** | CLI → JSON | no |
| IAM policy linting / wildcard & bad-pattern detection | **parliament** | lib/CLI → JSON | no |
| Comparative IAM truth: *"does B grant access not in baseline?"* | **AWS IAM Access Analyzer `check-no-new-access`** | AWS API | yes |
| Broad IaC misconfig (open SG, public bucket, unencrypted, …) | **Checkov**, **tfsec/Trivy**, **KICS** | CLI → JSON/SARIF | no |
| Transitive privilege-escalation / reachability graph | **PMapper**, **Cartography** | tool → JSON/graph | yes (account) |
| Network reachability (runtime, optional) | AWS Reachability / Network Access Analyzer | AWS API | yes |

### What we own (the actual product)

- **Git-ref orchestrator** — check out baseline + each fix in isolated worktrees;
  guarantee both fixes are scored against the *same* baseline.
- **Adapter + normalizer** — run each external tool, parse its output into one
  common model: a `Capability`/`Finding` with `{channel, principal?, action?,
  resource?, severity, source}`. Heterogeneous tools → one schema.
- **Differ** — `findings(fixA) △ findings(baseline)` vs. same for fix B; surface
  what each fix *adds* and *removes*.
- **Scorer** — a unified, tunable `reach × sensitivity` score over the normalized
  findings, so heterogeneous tool outputs collapse to one comparable number.
- **Verdict** — ranked result + the specific deltas that drove it.
- **Frontends** — VS Code webview (side-by-side graphs + diff) and CLI/CI (PR
  comment + exit code).

> Honest framing: this is an **integration/comparison product**. Its moat is the
> comparison UX, the normalization across tools, and the unified score — not
> analysis depth. If that's not worth building, the whole thing isn't; but
> "which branch is safer, with the reasons" is something no analyzer outputs.

### Reuse from this repo

| Existing | Role now |
|---|---|
| CFN/TF parsers, normalized graph schema | map resources/principals to nodes; attach normalized findings |
| Cycle-safe traversal | reachability over `iam`/`network` channels (offline reach) |
| Cytoscape/dagre renderer | side-by-side + diff visualization |
| Worktree-isolation pattern | the git-ref orchestrator |

---

## 4. Architecture (adapter model)

```
git refs: baseline, fixA, fixB
        │
        ▼  (isolated worktree per ref)
  ┌─────────────────────── ANALYZER ADAPTERS (run external tools) ──────────────────────┐
  │  Cloudsplaining → JSON   Checkov → SARIF   parliament → JSON   [AWS AA → API]         │
  └───────────────────────────────────────┬─────────────────────────────────────────────┘
                                           ▼
                          NORMALIZER  → common Finding/Capability model  (+ map onto graph nodes)
                                           ▼
   per ref: { findings[], reachSets, graph }      ── DIFFER ──▶  baseline△A   vs   baseline△B
                                           ▼                              ▼
                                        SCORER ──────────────────▶  ranked VERDICT + deltas
                                           │                              │
                              ┌────────────▼───────────┐     ┌────────────▼────────────┐
                              │ Webview: side-by-side  │     │ CLI/CI: PR comment +     │
                              │ graphs + diff highlight│     │ exit code / threshold    │
                              └────────────────────────┘     └──────────────────────────┘
```

Adapters are pluggable behind one interface, so adding/swapping a tool is a small,
isolated unit:

```ts
interface AnalyzerAdapter {
  id: string;                       // "cloudsplaining" | "checkov" | …
  available(): Promise<boolean>;    // tool installed / creds present?
  analyze(worktreeDir: string, target: string): Promise<Finding[]>;
}
```

---

## 5. The score

```
score(ref) = Σ over findings f added vs baseline:
   actionWeight(f.action) × sensitivityWeight(f.resource) × scopeFactor(f) × severity(f.source)
 + Σ over newly-exposed (resource, port):
   exposureWeight(port) × sensitivityWeight(resource)
```

- **actionWeight** — seeded from the IAM action dataset / Cloudsplaining risk
  categories (data-exfil, perms-management, priv-esc highest).
- **sensitivityWeight** — by resource type + tags (`data:pii`): secrets, KMS,
  databases/volumes high; logs/queues medium; ephemeral compute low.
- **scopeFactor** — wildcards (`Resource:*`, `s3:*`) multiply; breadth *is* risk.
- **severity(source)** — trust/weight per tool, configurable.

All weights live in a tunable `blast-radius.weights.json`. "Smallest blast
radius" = lowest score. The verdict always shows the deltas behind the number,
never just the number.

---

## 6. Decisions locked in

| Decision | Choice |
|---|---|
| Alternatives expressed as | **git refs/branches** vs. a baseline ref |
| Surface | **engine first**, then **two frontends** (webview + CLI/CI) |
| Metric | **security**, `reach × sensitivity`, tunable; change-score a secondary axis |
| Provider focus | **AWS first**, Terraform first |
| Build vs buy | **buy/outsource analysis; build comparison, normalization, scoring, workflow** |
| Integration posture | **Pluggable, offline by default** — ship OSS adapters; enable AWS-native adapters when creds are present |
| First adapter (P1) | **Cloudsplaining** (offline IAM, risk-classified JSON) |

---

## 7. Phasing

- **P0 — Adapter seam (small). ✅ DONE.** `Finding`/`AnalyzerAdapter`/normalizer/
  `Comparison` types in `src/compare/`. (Edge `channel` deferred until the webview
  phase, which is the only consumer.)
- **P1 — One analyzer, two refs (MVP). ✅ DONE.** Cloudsplaining adapter (Python
  shim → JSON), git-worktree orchestrator, policy extraction (CFN + bare JSON),
  scorer, differ, and the `blast-compare` CLI. Verified end to end on a real
  3-branch repo: `fix-scoped` scores 1,188× smaller than `fix-broad`. 33 unit
  tests passing. (Terraform `jsonencode`/policy-document HCL extraction is the
  documented follow-up.)
- **P2 — Second analyzer + aggregation + code lens. ✅ DONE.** Added the
  **Checkov** adapter (broad misconfig incl. network/public exposure, on the
  `network` channel) and a **granted-vs-used** lens (static AWS-SDK call
  extraction → mark IAM grants the linked code never invokes). Both wire in
  additively; findings are keyed by `source`+`channel` so heterogeneous outputs
  merge into one score without double-counting, and `unused_grant` is a
  weight-0 prioritization marker that re-weights existing findings via an
  `UNUSED_MULTIPLIER` (2×) rather than adding a new surface. Proven on real
  3-branch repos: (a) **cross-channel flip** — IAM-only ranks fix-A safest,
  IAM+network ranks fix-B safest (1/3 → 511/93); (b) **integrated** run shows
  Cloudsplaining + Checkov + the unused-grant lens all driving one verdict
  (fix-B 24× smaller). Also adds **principal reach**: `reach × sensitivity` now
  counts how many principals carry a policy (from the CFN attachment graph —
  `Roles`/`Users`/`Groups`, `ManagedPolicyArns`), so the *same* grant on a role
  shared by 6 services scores 6× a grant on a dedicated role
  (`examples/shared-reach`). 52 unit tests passing.
- **P3 — Webview comparison UX.** Side-by-side graphs, diff highlight (what fix B
  reaches that A doesn't), drill-down to the grants behind the score.
- **P4 — CI integration.** GitHub Action: post the verdict as a PR comment;
  optional failing threshold ("block if a fix increases blast radius by > N").
- **P5 — Optional depth.** AWS Access Analyzer adapter (true comparative IAM);
  PMapper adapter (transitive attack paths). Both behind the pluggable seam.

Each phase is independently useful.

---

## 8. Honest risks & boundaries

- **We're glue — glue must earn its keep.** Value is comparison + normalization +
  unified score + dev-loop, not analysis. If those aren't compelling, don't build.
- **Tool dependency & drift.** External tools change output formats and need
  installing/versioning. Mitigate: pin versions, treat each adapter's parser as a
  tested boundary with fixtures, degrade gracefully when a tool is absent.
- **Normalization is the hard technical problem.** Mapping different tools'
  findings into one model without double-counting or losing meaning is where the
  real engineering risk sits — budget for it.
- **Static ≠ runtime.** Offline analysis reads declared config, not deployed
  reality; over-approximation is intentional and labeled.
- **Granted-vs-used is a prioritization signal, not a removal gate.** The SDK-call
  extractor is heuristic (regex, not AST): a *missed* call under-counts "used" and
  so *over-counts* "unused" — the unsafe direction for this lens. It therefore
  re-weights (2×) rather than asserting "delete this," until extraction is
  AST-based. It also checks action-level, not resource-level, least privilege.
- **Code→principal→resource linking is unsolved in general.** The lens relies on an
  explicit `blast-usage.json` manifest (plus best-effort SAM inference). Tracing
  which principal runs which code, across managed policies / boundaries / assume-
  role chains, is future work; the manifest makes the human assert the mapping.
- **Principal reach is static-CFN only.** The attachment count comes from
  CloudFormation (`Roles`/`Users`/`Groups`, `ManagedPolicyArns`) in the analyzed
  templates. Cross-stack attachments, Terraform `aws_iam_role_policy_attachment`,
  and runtime `AttachRolePolicy` are not yet resolved; unknown attachment defaults
  to a reach of 1 (the safe, non-reducing direction).
- **Opinionated weights.** Must be tunable and explainable; verdict shows drivers.
- **AWS-first.** Other clouds deferred.
- **Same-baseline guarantee.** Both fixes scored against the *same* baseline ref;
  the orchestrator enforces it.

---

## 9. First concrete step

**P0 + P1:** define the adapter/finding/normalizer seam, ship a **Cloudsplaining
adapter**, orchestrate **two git refs** through normalize → diff → score, and
print the motivating-example verdict from a **CLI**, backed by golden tests.
Everything else (more adapters, webview, CI, AWS-native depth) layers on once the
metric proves meaningful on that one real comparison.
