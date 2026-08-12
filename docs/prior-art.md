# Prior art & positioning

> A rigorous, honest answer to: *"this feels like an obviously good idea — has
> someone already done it, or is it secretly a bad idea?"* Based on a prior-art
> scan (Aug 2026). Bottom line up front, then the evidence.

## TL;DR

- The **insight** behind our cross-analyzer feedback edge — *a public resource +
  a privileged identity that can reach it is worse than either alone* — is **not
  novel**. It is the flagship feature of the CNAPP / attack-path category
  ("toxic combinations"), shipping in Wiz, Google Cloud SCC, Prisma, CloudQuery,
  Tenable/Ermetic, and others.
- **Pre-deploy / shift-left** attack-path analysis on IaC is **also shipping**
  (Wiz scans `terraform plan` via HCP run tasks and blocks the apply).
- Even **differential, in-PR IAM checks** exist: AWS IAM Access Analyzer's
  `CheckNoNewAccess` / `CheckAccessNotGranted` compare a proposed policy against a
  reference and gate the PR. There are **patents** on scoring the least-privilege
  *delta* of a configuration change.
- What we found **no prior art for** is the specific combination this project is
  built around: **ranking two alternative remediations against each other, by
  blast-radius magnitude, across channels (IAM × exposure), from static IaC, with
  no cloud account.** That intersection is the defensible contribution — and it is
  a *framing/positioning* advantage, not a technical moat.

## The two axes

Locate any tool by (1) *when* it runs and (2) *what question* it answers.

| | **Absolute** — "score this state" | **Comparative** — "which is better?" |
|---|---|---|
| **Runtime / deployed state** | Wiz, SCC, CloudQuery, Tenable — toxic combinations | rare |
| **Pre-deploy on a plan** (resolved) | Wiz TF run tasks, Prisma code-to-cloud | AWS `CheckNoNewAccess` (IAM-only, boolean, vs. baseline) |
| **Static from IaC text** (unresolved) | Checkov / tfsec / KICS (single-resource rules) | **← this project** (cross-channel, magnitude, vs. each other) |

Two things separate our cell from the neighbors:

1. **Comparative *between two candidates*, not gating vs. a baseline.** AWS
   Access Analyzer answers *"is this change safe relative to what we had?"* (a
   boolean gate: did access expand?). We answer *"I'm shipping one of these two
   fixes regardless — which is the smaller blast radius?"* (a magnitude ranking of
   two alternatives). Different question, different output.
2. **Cross-channel in the comparison.** The differential IAM gates are IAM-only.
   Folding network/public-exposure into the *ranking* of two fixes (our feedback
   edge ①) is not something the differential tools do.

## What's occupied (with receipts)

**Toxic combinations / attack paths (runtime).** The core "identity × exposure ×
vuln = real path" fusion is a named, marketed capability:
- Wiz Security Graph "toxic combinations"; [Google Cloud SCC "toxic combinations
  and chokepoints"](https://docs.cloud.google.com/security-command-center/docs/toxic-combinations-overview);
  [CloudQuery "toxic IAM access combinations"](https://www.cloudquery.io/blog/investigating-toxic-iam-access-combinations-aws).

**Pre-deploy attack path on IaC (shift-left).** Not a gap:
- [Wiz + HCP Terraform](https://www.wiz.io/blog/wiz-hcp-terraform-close-the-cloud-security-gap):
  every `terraform plan` is scanned post-plan/pre-apply, predicts the security
  impact of proposed changes, identifies chained attack paths, and can **block the
  apply**. Crucially it does this by **correlating the plan against the deployed
  cloud graph** — i.e. it leans on *resolved* state (real ARNs), which is exactly
  what makes its cross-resource join tractable.

**Differential / before-after IAM checks in PRs.** The "comparative" idea is not
untouched:
- AWS IAM Access Analyzer `CheckNoNewAccess` ("does the new policy grant access
  the old one didn't?") and `CheckAccessNotGranted`, both wire-able into CI/PRs.
  IAM-only, boolean, and framed as a **gate against a baseline**, not a ranking of
  alternatives.
- An emerging "differential security review" practice (documented blast-radius
  calculations, security delta between proposed and existing policies).

**Scoring a config change's security delta.** Patented in the least-privilege
framing (evaluate whether a new rule *increased or decreased* a least-privilege
score). IAM-centric; not comparative-between-fixes; but conceptually adjacent —
worth knowing it exists as IP.

## What genuinely survives as novel

Narrowed, and stated precisely:

1. **"Which fix?" as the primary output.** Ranking two candidate remediations by
   blast-radius magnitude — a *choice between alternatives*, not a *gate against a
   baseline*. This is the real white space.
2. **Cross-channel fusion inside that comparison** (IAM × exposure), rather than
   IAM-only differential checks.
3. **Zero-cloud, pure-OSS orchestration** — no account, no `terraform plan`, no
   agent; diff two git refs with off-the-shelf scanners (cloudsplaining, Checkov).
   A real posture differentiator — but see the caveat below, because it is also
   the source of our worst weakness.

## The critique — and why the comparative framing partly answers it

The Cloud Security Alliance argues [toxic combinations are *inadequate*](https://cloudsecurityalliance.org/blog/2024/04/02/toxic-combinations-are-inadequate-a-case-study):
static posture analysis enumerates *theoretical* attack chains that rarely
correspond to real exploitation, producing **alert fatigue** (a ranked backlog
most teams never finish) with **no evidence** that any given combination is
actually being exploited; their proposed fix is runtime detection.

Our tool is squarely in the static/posture camp, so it inherits the "theoretical,
no runtime evidence" complaint. **But the comparative framing sidesteps the
critique's main mechanism.** The critique is aimed at *absolute prioritization* —
"here are your top-N risks" → fatigue → most ignored. We don't emit a backlog. We
answer a **bounded decision the developer is already committed to making**: they
*will* merge one of two fixes; we say which is smaller. There is no queue to
ignore, and "is this actively exploited?" is the wrong question when you're
*choosing between two designs* rather than triaging existing risk. So the
comparative reframing is not just an unoccupied niche — it is, in part, a
**response** to a known failure mode of the paradigm.

## Honest caveats

- **Novelty ≈ difficulty ≈ weaker soundness.** The reason "static from IaC,
  no cloud state" is less occupied is that it's *harder* and gives *weaker*
  guarantees. CNAPPs do cross-resource joins from resolved state (real ARNs); we
  join by string-matching resource names out of IaC text, which is brittle and
  fails silently (a missed join = no amplification, and you'd never know). Wiz
  avoids this by operating on the `terraform plan`, where names are resolved.
- **It's an incremental combination, not a primitive.** Every ingredient exists;
  the contribution is the *composition and framing*. A differential gate that
  compares `main` vs. PR is one refactor from a tool that compares `fix-A` vs.
  `fix-B`. Unoccupied ≠ defensible.
- **The magnitude is heuristic.** Weights (and the `×3` exposure multiplier) are
  uncalibrated. The comparison is more trustworthy than the absolute number,
  because ranking two near-identical configs is far less sensitive to
  weight-arbitrariness than absolute scoring — but the number itself should not be
  read as meaningful.

## Verdict

Not "someone already did exactly this," and not a bad idea. The *insight* is fully
precedented; the *comparative, cross-channel, choose-between-two-fixes framing* is
the part that's actually ours, it's underserved, and it happens to answer a
published critique of the posture paradigm. Treat it as a positioning advantage
and a decision-support niche — not a technical moat.

## Sources

- [Google Cloud SCC — Toxic combinations & chokepoints](https://docs.cloud.google.com/security-command-center/docs/toxic-combinations-overview)
- [CloudQuery — Toxic IAM access combinations in AWS](https://www.cloudquery.io/blog/investigating-toxic-iam-access-combinations-aws)
- [Wiz + HCP Terraform — close the IaC-to-cloud gap](https://www.wiz.io/blog/wiz-hcp-terraform-close-the-cloud-security-gap)
- [Wiz + HashiCorp — Terraform Run Tasks](https://www.wiz.io/blog/wiz-and-hashicorp-integration-cloud-run-tasks)
- [Wiz — IaC scanning guide](https://www.wiz.io/academy/application-security/iac-scanning)
- [AWS IAM Access Analyzer deep dive — CheckNoNewAccess / CheckAccessNotGranted in CI](https://hidekazu-konishi.com/entry/aws_iam_access_analyzer_deep_dive.html)
- [CSA — "Toxic Combinations Are Inadequate: A Case Study"](https://cloudsecurityalliance.org/blog/2024/04/02/toxic-combinations-are-inadequate-a-case-study)
- [Empirical study of security practices in IaC (arXiv 2308.03952)](https://arxiv.org/pdf/2308.03952)
