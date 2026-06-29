# Design Document: Infrastructure "Blast Radius" Visualizer (VS Code Extension)

> Revision 2. Supersedes the initial draft. Changes from v1 are summarized in
> [Appendix A](#appendix-a--changes-from-v1).

## 1. Executive Summary

Changes to CloudFormation templates or Terraform configurations often introduce
unintended side effects. This tool gives infrastructure engineers an interactive,
localized dependency graph inside VS Code. It parses resource relationships, then
maps and quantifies the cascading **blast radius** of a proposed modification
*before* deployment — distinguishing what merely depends on a resource from what
will actually be **replaced, updated, or destroyed**.

The tool answers two questions about a selected resource:

1. **Structural** (always available, instant): *what transitively depends on this?*
2. **Severity** (on demand): *how badly is each dependent impacted* — replace,
   update-in-place, or no-op — based on a real `terraform plan` / CloudFormation
   change set.

---

## 2. System Architecture & Component Design

The system separates static source analysis from the rendering environment, and
separates the **structural graph** (cheap, live) from the **severity overlay**
(expensive, on demand).

```
+-------------------------------------------------------------------------------------+
|                                 VS CODE EXTENSION                                   |
|                                                                                     |
|  +-----------------------------------+          +-------------------------------+   |
|  | Extension Host (Backend, TS)      |          | Webview Panel (Frontend)      |   |
|  |                                   |          |                               |   |
|  |  [Trigger / Active Editor]        |          |     +---------------------+   |   |
|  |            |                      | graph     |     |   Cytoscape.js UI   |   |   |
|  |            v                      | (JSON)    |     |   dagre layout      |   |   |
|  |  [Provider Detect: CFN | TF]      |---------->|     |                     |   |   |
|  |            |                      | severity  |     |  Interactive Graph  |   |   |
|  |   +--------+--------+             | (JSON)    |     +----------+----------+   |   |
|  |   |                 |             |---------->|                |              |   |
|  |  [CFN Parser]   [TF Adapter]      |          |                v              |   |
|  |   (in-memory)   (terraform CLI)   |<----------|   [Blast Radius Traversal]   |   |
|  |   |                 |             | requests  |   (reverse reachability +    |   |
|  |   v                 v             | (select,  |    edge-weighted severity)   |   |
|  |  [Graph Generator (normalized)]   |  run-plan)|                               |   |
|  |   |                                |          +-------------------------------+   |
|  |   v                                |                                              |
|  |  [Severity Engine (plan/changeset)]|                                              |
|  +-----------------------------------+                                              |
+-------------------------------------------------------------------------------------+
```

### 2.1 Backend: Extension Host (TypeScript)

* **Trigger Module:** Registers command `infra-blast-radius.visualize` (command
  palette + editor title icon + context menu) for `.tf`, `.json`, `.yaml`, `.yml`.
* **Provider Detection:** Sniffs the active file to route to the correct parser:
  `.tf` → Terraform; JSON/YAML containing a top-level `Resources` map (and
  optionally `AWSTemplateFormatVersion`) → CloudFormation. Ambiguous files prompt
  the user.
* **Parser Subsystem** (see §3).
* **Graph Generator:** Normalizes parsed entities into the abstract graph schema
  (§4). Deduplicates edges and tags each edge with a **dependency kind** (§4.2).
* **Severity Engine:** On demand, produces per-node action severity from a real
  plan / change set (§5).

### 2.2 CloudFormation Parser (in-memory, live)

Parses the **unsaved editor buffer** directly — no disk read, updates as you type.

* Loads YAML with a **CloudFormation tag schema** (`!Ref`, `!GetAtt`, `!Sub`,
  `!ImportValue`, etc. are custom YAML tags that default parsers reject). JSON
  templates parse natively.
* Walks logical IDs under `Resources`. Extracts dependencies from:
  * `Ref` — **filtered to logical IDs that exist under `Resources`** (a `Ref` may
    also point at a Parameter or pseudo-parameter such as `AWS::Region`; those are
    not resource edges).
  * `Fn::GetAtt` (both `!GetAtt A.Attr` and `["A","Attr"]` forms).
  * `Fn::Sub` — **scans the template string for `${LogicalId}` and
    `${LogicalId.Attr}` interpolations**; this is the dominant implicit-dependency
    carrier in real templates and was missing in v1.
  * `DependsOn` — explicit, tagged as a **soft** edge (§4.2).
  * Also recognized: `Fn::ImportValue`, `Fn::FindInMap`, and `Condition` refs
    (best-effort; cross-stack imports are out of scope, §7).

### 2.3 Terraform Adapter (delegated to the `terraform` CLI)

Per the decision to shell out rather than bundle an HCL parser, Terraform analysis
delegates to the local CLI and runs against the **saved workspace directory** (a
Terraform config is the *set* of `.tf` files in a directory, not a single file):

* **Structure:** `terraform graph` → parse the DOT output into nodes/edges. This
  natively resolves implicit references, `var`/`local`/`data` indirection, and —
  importantly — **module wiring**, which a naive file parser cannot.
* **Module flattening + IO edges:** `terraform graph` emits fully-qualified
  addresses (`module.net.aws_vpc.main`). We **flatten** these into the root graph
  and **preserve cross-module edges** so the graph stays connected (v1's flat
  flattening would have fragmented it). Module addresses are kept as a `module`
  field on the node for grouping/labeling.
* **Severity:** `terraform plan -out=tfplan` then `terraform show -json tfplan` →
  read `resource_changes[].change.actions` (§5).

**Preconditions & failure modes:** requires `terraform` on `PATH` and an
initialized workspace (`.terraform/`). If `terraform` is absent or the workspace
is uninitialized, the structural graph degrades to a **best-effort address-level
scan** of the buffer (resource blocks only, no reference resolution) and the
severity overlay is disabled with an actionable message ("Run `terraform init` to
enable severity"). See §6 for the error states.

### 2.4 Reconciling the input model (live buffer vs. CLI) — key assumption

The chosen inputs are in tension: **plan-based severity** and the **`terraform`
CLI** operate on *saved, initialized files on disk*, while **"live unsaved
buffer"** is in memory. Resolution — a **two-tier model**:

| Tier | Source | Latency | Provider behavior |
|------|--------|---------|-------------------|
| **Structural graph** | Live buffer (CFN) / saved dir (TF) | Instant (CFN) | CFN parses the in-memory buffer on every change (debounced). TF runs `terraform graph` against the saved directory, refreshed on save or explicit trigger. |
| **Severity overlay** | Saved + initialized workspace | Seconds | On demand only (user clicks "Compute severity"). Requires a writable, initialized workspace. |

> **Assumption to confirm:** for Terraform, live-as-you-type is not feasible
> through the CLI, so TF structural refresh is **save-triggered**, not
> keystroke-triggered. CloudFormation keeps the true live-buffer experience.
> Override this if you want a bundled HCL parser for live TF structure (reverses
> the earlier "shell out" decision).

### 2.5 Frontend: Webview Canvas

* **Renderer:** Cytoscape.js with the **`dagre` (hierarchical DAG) layout** — not
  force-directed. Dependency graphs are near-trees; dagre is faster, deterministic,
  and visually encodes dependency direction. (v1's "force-directed for performance"
  rationale was inverted.)
* **Security:** strict **Content-Security-Policy with a per-load nonce**; scripts
  loaded from the bundle via `webview.asWebviewUri` with `localResourceRoots`.
  `retainContextWhenHidden: true` plus state serialization for panel restore.
  (Omitting CSP/nonce is the most common cause of a silently blank webview.)
* **Blast-radius traversal runs in the webview** over the already-delivered graph
  JSON, so hover/select is instant and offline. Severity, when requested, is fetched
  from the host via the message protocol (§5.3 / §2.6).

### 2.6 Message Protocol (host ⇄ webview)

Bidirectional, versioned, typed. Every message: `{ v: 1, type, payload }`.

* **host → webview:** `graph/loaded`, `severity/result`, `error`, `status`
  (`loading` | `parsing` | `ready`).
* **webview → host:** `node/selected` (request severity for a node),
  `command/run-plan`, `ready`.

---

## 3. Parser Output — Normalized Graph Schema

The parser emits a provider-agnostic schema; the frontend needs no Terraform/CFN
domain knowledge.

```jsonc
{
  "schemaVersion": 1,
  "provider": "terraform",            // "terraform" | "cloudformation"
  "nodes": [
    {
      "id": "aws_vpc.main",
      "label": "VPC (main)",
      "type": "network",              // category; see §3.1
      "module": null,                 // e.g. "module.net" when flattened, else null
      "severity": null                // filled by the severity overlay: null|"noop"|"update"|"replace"|"destroy"
    }
  ],
  "edges": [
    {
      "id": "aws_subnet.public_a->aws_vpc.main",   // stable, derived; enables dedup
      "source": "aws_subnet.public_a",             // the DEPENDENT
      "target": "aws_vpc.main",                     // the DEPENDENCY
      "kind": "hard"                                // "hard" | "soft"; see §4.2
    }
  ]
}
```

* **Edge direction (normative):** `source` **depends on** `target`. All four
  artifacts in this doc — schema, formula, diagrams, UX — use this one convention
  (v1 mixed "downstream"/"children" with reverse traversal, which inverted the
  meaning).
* **Edge IDs are derived** (`source->target`) so the same dependency discovered via
  two paths (e.g. `Ref` and `Fn::Sub`) collapses to one edge.

### 3.1 Node type taxonomy

`type` comes from a maintained resource-type → category lookup
(`aws_vpc`/`aws_subnet` → `network`, `aws_instance` → `compute`, …). The map is
partial by design; unknown types fall back to `"unknown"`. This is presentation
only and never affects traversal.

---

## 4. Blast Radius — Structural Model

Model the configuration as a directed graph `G = (V, E)` where `V` are resources
and an edge `(u → v)` means **`u` depends on `v`**.

### 4.1 Impact set (dependents)

If resource `t` is altered or destroyed, the impacted set is everything that
**transitively depends on `t`** — i.e. all nodes that can reach `t` by following
edges forward:

```
R(t) = { u ∈ V | there exists a directed path u → … → t }
```

Equivalently: traverse **incoming** edges of `t` (reverse direction) transitively.

```
   [ VPC ]  <----  [ Subnet ]  <----  [ EC2 ]      edges point DEPENDENT → DEPENDENCY
      ^
      |
   [ Security Group ]

   Changing VPC ⇒ R(VPC) = { Subnet, EC2, Security Group }
```

### 4.2 Edge kinds (hard vs. soft)

Each edge is classified, because dependency *kind* governs how severity propagates
(§5.2):

| Kind | Terraform source | CloudFormation source | Meaning |
|------|------------------|------------------------|---------|
| **hard** | implicit attribute references (`aws_vpc.main.id`) | `Ref`, `Fn::GetAtt`, `Fn::Sub` interpolation | Child consumes a real attribute value of the parent. |
| **soft** | `depends_on` | `DependsOn` | Ordering only; no value flows. |

### 4.3 Cycle safety

The graph is **not assumed acyclic.** Mutually-referencing security groups,
`depends_on` loops, and — routinely — half-edited buffers produce cycles.
Traversal uses an explicit visited set (iterative DFS/BFS); cycles are detected,
broken for traversal, and surfaced as a non-fatal warning badge.

---

## 5. Blast Radius — Severity Quantification (the "how broken" layer)

Structural reachability answers *whether* a resource is in the blast radius.
**Severity answers how badly**, and — as established — true breakage (replace vs.
update vs. no-op) is a property of the *change* and the provider's update
semantics, so it is computed from a **real plan**, not statically.

### 5.1 Sources of truth

* **Terraform:** `terraform plan -out=tfplan` → `terraform show -json tfplan`.
  Map `resource_changes[].change.actions`:
  * `["delete","create"]` (replace) / `["delete"]` → **replace / destroy** (red)
  * `["update"]` → **update-in-place** (amber)
  * `["no-op"]` / `["read"]` → **no-op** (neutral)
* **CloudFormation:** `aws cloudformation create-change-set` →
  `describe-change-set`. Map each change's `ResourceChange.Action` and
  `Replacement` (`True`/`Conditional`/`False`):
  * `Replacement=True` or `Action=Remove` → **replace / destroy** (red)
  * `Replacement=Conditional` → **conditional** (amber, hatched)
  * `Action=Modify, Replacement=False` → **update-in-place** (amber)

Both require credentials/initialized state; both run **only on explicit user
action** and never on the live buffer.

### 5.2 Edge-weighted propagation (when a plan is unavailable)

When the user wants a quick "what-if" without running a full plan, severity is
**estimated** by propagating from the changed node along edges, weighted by kind:

* A **replace/destroy** of a parent propagates **replace risk** to children across
  **hard** edges (they consume an attribute that may change / force-new) but **not**
  across **soft** edges (`depends_on` enforces order, not value flow, and does not
  force replacement).
* Distance attenuates confidence: direct hard dependents = high, multi-hop = lower.

This is clearly labeled an **estimate** in the UI to distinguish it from
plan-grounded severity. (It is the heuristic fallback; §5.1 is the source of truth.)

### 5.3 Severity flow

```
user selects node ──▶ webview: node/selected ──▶ host
host: have a fresh plan?  ── yes ─▶ severity/result (authoritative)
                          └─ no ──▶ offer "Run plan" (authoritative, slow)
                                    or show edge-weighted estimate (instant)
```

---

## 6. UI/UX Interaction Flow & States

1. **Trigger.** Open a template/config and run `Visualize Blast Radius` (palette,
   title-bar map icon, or context menu).
2. **Structural render.** Host parses (CFN: live buffer; TF: saved dir) and opens a
   split-column webview. Graph loads with neutral styling and a dagre layout.
3. **Interactive selection.** Hover/click a node → the webview computes `R(node)`
   instantly. Dependents highlight; unaffected nodes fade. A toggle switches the
   highlight between **dependents** ("what breaks if I change this") and
   **dependencies** ("what this needs").
4. **Severity (on demand).** "Compute severity" runs the plan/change set and
   recolors impacted nodes by real action (replace=red, update=amber, no-op=neutral).
   Until then, the optional edge-weighted *estimate* may be shown, labeled as such.

**Explicit non-happy states** (absent in v1):

* **Loading / running plan** — progress indicator; webview stays interactive on the
  last good graph.
* **Parse error / mid-edit invalid buffer** — keep the last valid graph, show a
  non-blocking "stale — fix syntax to refresh" banner.
* **Empty** — no `Resources` / no resources found.
* **TF prerequisites missing** — `terraform` not found or uninitialized: structural
  graph degrades to best-effort, severity disabled with a fix-it message.
* **Cycle detected** — non-fatal warning badge (§4.3).

---

## 7. Scope Boundaries & Trade-offs

* **Static structure, on-demand dynamic severity.** Structure comes from local
  files; severity comes from a real plan/change set the user opts into. Remote
  state objects (`terraform_remote_state`) and external SSM/Parameter-Store lookups
  are resolved only insofar as `terraform`/the plan resolves them.
* **Terraform modules: flattened with preserved IO edges.** Nested modules inline
  into the root graph; cross-module dependency edges are kept so the blast radius is
  correct, with the originating module retained as node metadata for grouping.
* **CloudFormation cross-stack** (`Fn::ImportValue` to another stack's exports,
  nested stacks) is out of scope for the MVP — single-template only.
* **Severity needs credentials/initialized workspace.** Without them, the tool
  still delivers the full structural blast radius plus the labeled estimate.
* **Scale:** "localized" view renders the N-hop neighborhood of the selected node
  with collapse/expand, so large stacks (hundreds–thousands of resources) stay
  responsive rather than rendering everything at once.

---

## 8. Testing Strategy

* **Golden-file parser tests:** fixture template/config in → expected normalized
  graph JSON out, covering each reference form (`Ref`, `GetAtt`, `Sub`, `DependsOn`,
  implicit TF refs, module IO, cycles, `Ref`-to-parameter exclusion).
* **Severity-mapping tests:** stub `terraform show -json` / `describe-change-set`
  payloads → expected node severities.
* **Traversal tests:** reachability with cycles, multi-hop, and disconnected
  components.

---

## Appendix A — Changes from v1

| Area | v1 | v2 |
|------|----|----|
| TF parsing | "JSON schemas or `.tfstate`" with a JSON parser | Shell out to `terraform` (`graph` + `plan`/`show -json`); `.tf`/HCL via CLI |
| TF input scope | Active file | Whole saved directory (a TF config is the dir) |
| Modules | Flat (would fragment graph) | Flattened **with preserved IO edges**; module kept as metadata |
| Input source | Active editor | Two-tier: live buffer (CFN) + saved/initialized workspace (TF & all severity) |
| Severity | None (binary reachability) | Plan/change-set-based (replace/update/no-op) + edge-weighted estimate fallback |
| Edge model | Untyped | Typed **hard/soft**; governs severity propagation |
| Direction | "downstream/children" + reverse traversal (contradictory) | One normative convention: `source` depends on `target` |
| CFN refs | `Ref`, `GetAtt`, `DependsOn` | + `Fn::Sub` interpolation, `Ref`-to-param filtering, CFN YAML tag schema |
| Layout | Force-directed "for performance" | dagre hierarchical (faster, deterministic) |
| Cycles | Assumed DAG | Explicit cycle-safe traversal |
| Webview | "isolated iframe" | CSP + nonce, `asWebviewUri`, state retention |
| Protocol | One-way postMessage | Versioned bidirectional typed protocol |
| Error states | None | Loading / parse-error / empty / TF-prereqs / cycle |
| Testing | None | Golden-file + severity-mapping + traversal tests |
