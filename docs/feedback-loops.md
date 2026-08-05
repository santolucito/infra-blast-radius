# Feedback loops between analyzers

> Status: design + first prototype (`reachability → IAM`, edge ①). See
> `src/compare/reachability.ts` and `examples/exposed-bucket/`.

## The problem: today the analyzers run in parallel and we union the results

`blast-compare` sits several analyzers behind one adapter interface, runs each
over the same worktree, normalizes every output into a `Finding`, and **sums**
the scored findings:

```
cloudsplaining ─┐
checkov ────────┼─► [Finding]  ─► key by (source,channel) ─► Σ weight ─► score
usage lens ─────┘        (+ two hardcoded re-weight passes)
```

Each analyzer is **blind to what the others found**. Cloudsplaining scores a
`s3:PutBucketPolicy` grant identically whether the bucket it targets is locked
down or wide open to the internet — because "wide open to the internet" is a
*Checkov* fact, on a different channel, that never reaches the IAM scorer. We
add the two findings; we never let one *inform* the other.

The two post-passes we already have (`applyUsageLens`, `applyPrincipalReach`)
are, in fact, primitive feedback edges — they take a global fact and re-weight
findings — but each is a bespoke, hardcoded pass. There's no general mechanism
for "one analyzer's output sharpens another's."

## The inspiration: Velvet's multi-modal verification

Gladshtein et al., *Velvet: A Foundational Multi-Modal Verifier for Imperative
Programs in Lean* (CAV'26), makes a sharp version of this point. Velvet is **not**
"run Dafny, a fuzzer, and a proof assistant in parallel and collect verdicts."
It's several verification *modes* — SMT automation, interactive Lean tactics,
property-based testing — over **one shared substrate** (the VCs are just Lean
theorems; the proof context is shared). The value is in the hand-offs:

- **Failure yields a consumable artifact, not a verdict.** When SMT can't
  discharge a verification condition, it doesn't report "unknown" — it leaves a
  *proof goal with named hypotheses* that the next mode picks up.
- **`@[solverHint]` is the explicit feedback edge.** A fact proven interactively
  is injected *back into the SMT theory database*, so the automated solver can
  now use it. Interactive → automated feedback.
- **Diagnostics are witnesses.** A failed termination proof says "the measure
  `x+1-i` does not decrease," a concrete pointer that steers the next attempt —
  not just "failed."

The transferable lesson: **don't union independent results — give the tools a
shared context where each one's output becomes another's input.**

## The mapping onto blast radius

Our analyzers already emit facts about the *same underlying resources* — they
just describe them in different vocabularies on different channels. The shared
substrate we're missing is a **resource-keyed fact store** (a blackboard) that
every analyzer writes to and every scorer reads from. Three feedback edges fall
out of that, in increasing order of ambition:

### ① Reachability → IAM weight  *(the prototype)*

**Producer:** Checkov's `public_exposure` verdict on a resource *R*.
**Consumer:** cloudsplaining's IAM findings whose actions target *R*.

A broad IAM grant on a *private* bucket is a latent risk; the **same grant on a
publicly-reachable bucket** is a live exfiltration/tamper path — a write to a
public bucket is defacement, a read is a leak. Neither tool sees this alone:
cloudsplaining doesn't know the bucket is public, Checkov doesn't know who can
write to it. The feedback edge multiplies the IAM finding's weight when its
target resource is flagged reachable.

This is the truest analogue of Velvet's cross-mode hand-off, because it's two
*different* tools on two *different* channels informing each other — not one
analyzer refining itself.

### ② Usage → IAM re-parameterization

**Producer:** the granted-vs-used lens's *actually-invoked* action set.
**Consumer:** cloudsplaining, re-interpreted over used vs. granted actions.

Today the usage lens only *annotates* existing findings (`unused: true`, ×2).
The deeper edge: score the IAM blast radius **twice** — once over the granted
action set (potential blast) and once over the actually-invoked set (real
blast) — and make **the gap** the finding. That's using one tool's output to
*re-parameterize* the other's analysis, exactly like feeding `@[solverHint]`
lemmas back into the solver.

### ③ Effective-set → shadow diagnostic  *(the witness)*

**Producer:** the effective allowed-action union across a policy's statements.
**Consumer:** a diagnostic explaining a null result or a leak.

When a proposed fix *removes* a statement but the action is still granted by
another statement, the score doesn't move — and today we say nothing about why.
The witness: *"you removed `LakeExtra`, but `s3:PutBucketPolicy` is still granted
via `LakeFull`'s `s3:*`."* This is Velvet's termination-diagnostic pattern: a
concrete witness for why an analysis came back the way it did. `messy-baseline`
is the example built for it.

## The architecture: a resource-keyed blackboard, refined to a fixpoint

Replace the flat `analyze → union → score` with **emit facts → refine → score**:

1. `AnalysisContext` gains a `facts` blackboard, keyed by a normalized
   **resource identity** (`s3:pipeline-lake`, `sg:job`, …). This is the shared
   substrate — the analogue of Velvet's shared proof context.
2. Analyzers **emit facts** as well as findings (`{resource, public: true}`,
   `{resource, usedActions: [...]}`), and **read** facts others emitted.
3. Scoring becomes **context-sensitive**: a finding's weight is a function of
   the facts about its subject's resources, not a flat category lookup.
4. Iterate the refinement passes until findings stabilize (one or two rounds in
   practice).

The hard, honest part is step 1: **resource identity across tools.** Checkov
names an S3 bucket `aws_s3_bucket.lake` (a Terraform logical id); an IAM policy
names it `arn:aws:s3:::pipeline-lake/*` (an ARN). Joining them is a real problem
— and it's the same problem Velvet solves by construction with a single shared
representation. Our prototype resolves it for S3 (bucket name from the ARN,
bucket name from the Terraform `bucket = "…"` attribute) and treats that resolver
as the extensible seam. The prototype does **not** yet generalize the blackboard;
it implements edge ① as a focused post-pass (`applyReachabilityFeedback`) that
proves the shape before we abstract it.

## Prototype scope (edge ①)

- `src/compare/reachability.ts` — the feedback pass: collect public resources
  from Checkov findings, resolve which resources each IAM finding targets, and
  set `exposureFactor` on IAM findings that touch a public resource.
- `Finding.exposureFactor` (like `reachFactor`): multiplies the finding's weight
  in `score.ts`. Not part of `findingKey`.
- `examples/exposed-bucket/` — a baseline plus two fixes where the ranking
  **flips** once the feedback edge is on: the "narrower IAM" fix leaves write
  access to a *public* bucket, which the edge reveals as the larger blast radius.
