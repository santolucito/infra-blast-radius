# Example: the same grant costs more on a shared role (principal reach)

Blast radius is `reach × sensitivity` — and **reach includes how many identities
hold a grant**, not just what the grant allows. A permission on a role attached to
6 services is reachable by all 6. This example isolates that: the *identical* IAM
statement is added two ways, and the only difference is **who carries it**.

## The scenario

A shared `PlatformAccess` managed policy is attached to 6 service roles. A
reporting service needs `secretsmanager:GetSecretValue`. Two fixes add the **exact
same statement** — the difference is placement:

|            | **fix-A**                                       | **fix-B**                                              |
|------------|-------------------------------------------------|--------------------------------------------------------|
| Where      | a **new dedicated** managed policy on 1 role     | added to the **shared** `PlatformAccess` policy (6 roles) |
| The pitch  | "give the reporting service its own policy"      | "just add it to the platform policy — one line"        |
| Grant      | `secretsmanager:GetSecretValue` on `*`           | `secretsmanager:GetSecretValue` on `*` (byte-identical) |

fix-B is a one-line change and looks tidier. But it hands `GetSecretValue` to all
6 services that share the role — 6× the reach.

## Run it

```bash
npm run compile
pipx install cloudsplaining

DEST=$(examples/shared-reach/build-repo.sh)
# --no-checkov keeps the focus on IAM reach (there is no network config here)
node dist/cli.js --repo "$DEST" --base main --ref:A fix-A --ref:B fix-B --no-checkov
```

## What you should see

```
A (fix-A)   score 173   (+41 vs baseline)
    • data_exfiltration: 1
B (fix-B)   score 378   (+246 vs baseline)
    • data_exfiltration: 1
    • shared-role reach: ×6 (grant lands on multiple principals)
✅ Smallest blast radius: A (fix-A) — 2.2x smaller than B
```

The delta is the tell: the **same** grant costs `+41` on the dedicated role and
`+246` — exactly **6×** — on the shared one. Before principal reach was modeled,
both scored `+41`; the tool couldn't see that fix-B's grant lands on 6 identities.

## How it works

`policy-extract.ts` reads the CloudFormation attachment graph — a managed/inline
policy's `Roles`/`Users`/`Groups`, and roles that reference it via
`ManagedPolicyArns` — and records how many principals carry each policy. The
scorer multiplies that policy's findings by the count (`reachFactor`). Bare policy
`.json` files can't express attachment, so they default to a reach of 1 (the safe,
non-reducing direction).

## Boundary

Reach is counted from **static CloudFormation** attachments in the analyzed
templates. Cross-stack attachments, Terraform `aws_iam_role_policy_attachment`,
and runtime `AttachRolePolicy` calls are not yet resolved — a documented follow-up
(`PLAN.md` §8).
