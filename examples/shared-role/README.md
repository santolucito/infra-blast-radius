# Example: when the "reuse the shared role" fix is the bigger blast radius

The companion to [`../tradeoff`](../tradeoff). There, the fix with the *prettier
IAM diff* (fix-A) turned out to be worse because it opened the network. Here it
flips: **fix-A — a dedicated least-privilege role — is genuinely the safer fix,
and the tool says so, by 5,295×.**

The point: the tool is not biased toward any channel or any "shape" of fix. It
measures the actual blast radius. Sometimes that means the extra IAM permissions
in a fix are *fine*; here it means they're catastrophic, because they come from a
**shared role**.

## The scenario

A reporting job needs to read one object from an export bucket (`src/handler.js`
only ever calls `s3:GetObject`). It's currently bootstrapped with `s3:*` — must
change. Two fixes:

|            | **fix-A**                                            | **fix-B**                                                            |
|------------|------------------------------------------------------|---------------------------------------------------------------------|
| Approach   | give the job its **own** dedicated role               | **reuse the shared `PlatformAccess` role** everything else uses     |
| The pitch  | least privilege                                       | "don't create role sprawl — consolidate on the existing role"       |
| IAM result | `s3:GetObject` on one bucket — exactly what it uses   | inherits the platform role: `s3:*`, `dynamodb:*`, `kms:Decrypt`, a secret, SQS — on `*` |

fix-B is the seductive one: in a real PR it's a **one-line change** ("attach the
shared role"), and you never *see* the ~80 permissions you're inheriting. "Reuse
the existing role instead of making another" is a legitimate-sounding instinct.

## Run it

```bash
npm run compile
pipx install cloudsplaining            # checkov not needed here (no network)

DEST=$(examples/shared-role/build-repo.sh)
node dist/cli.js --repo "$DEST" --base main --ref:A fix-A --ref:B fix-B
```

## What you should see

```
A (fix-A)  score 1       (dedicated role: s3:GetObject — the one action the code uses)
B (fix-B)  score 5295    (+1312 vs baseline — worse than the s3:* it replaced!)
   • write: 38 · infrastructure_modification: 43 · data_exfiltration: 1 · service_wildcard: 1
   • unused grants (never called by linked code): 82
✅ Smallest blast radius: A (fix-A) — 5295x smaller than B
```

Two things the tool makes visible that the one-line PR hides:

1. **What the shared role actually grants.** It expands `PlatformAccess` and shows
   the job just received `s3:*` + `dynamodb:*` + `kms:Decrypt` + a secret — 82
   concrete actions, several high-risk.
2. **How little of that the job uses.** The granted-vs-used lens flags **82 unused
   grants**: the code calls `s3:GetObject` and nothing else. fix-B hands the job a
   mountain of permissions it will never touch — pure, unnecessary blast radius.

"Consolidate on the shared role" *sounds* tidier than "make another role." The
tool quantifies why, here, least privilege wins decisively.
