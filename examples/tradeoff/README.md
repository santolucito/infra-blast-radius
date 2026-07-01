# Example: a cross-channel tradeoff (no obvious winner)

Most "which fix is safer" demos are softballs — one side uses `Action: "*"`, so
it obviously loses. This example is the hard case: **neither fix uses a wildcard,
both are legitimate remediations of the same over-broad baseline, and which one
is "safer" is a threat-model judgment, not a fact.** It's the case that shows what
the tool is actually for.

## The scenario

A batch job starts with `s3:*` on a locked-down private network — everyone agrees
this must change. Two engineers open two competing least-privilege PRs:

|            | **fix-A**                                             | **fix-B**                                                                    |
|------------|-------------------------------------------------------|------------------------------------------------------------------------------|
| IAM        | textbook least privilege: `s3:GetObject`+`PutObject` on one bucket | broader but all scoped: adds `secretsmanager:GetSecretValue` on one secret + `dynamodb:GetItem/PutItem` on one table |
| Network    | opens the SG to `0.0.0.0/0` + public IP (to reach an external license server) | untouched — stays private                                     |
| The pitch  | "perfect IAM hygiene"                                  | "keep the network locked, go AWS-native"                                     |

The naked-eye read favors **fix-A**: its IAM diff is gorgeous. fix-B *looks*
scarier (it holds a secret and touches a database). A reviewer's eye approves A.

## Run it

```bash
npm run compile                       # once, to build dist/cli.js
pipx install cloudsplaining checkov   # the two analyzers (both optional)

DEST=$(examples/tradeoff/build-repo.sh)

# default weights
node dist/cli.js --repo "$DEST" --base main --ref:A fix-A --ref:B fix-B

# a threat model that discounts network exposure (egress behind a firewall, etc.)
node dist/cli.js --repo "$DEST" --base main --ref:A fix-A --ref:B fix-B \
  --weights examples/tradeoff/weights-network-discounted.json
```

## What you should see

```
Default weights:              A = 617    B = 180    -> B wins 3.4x
Network-discounted weights:   A = 24     B = 15     -> B wins 1.6x  (near tie)
```

Two takeaways:

1. **The tool contradicts the naked eye.** Under defaults it rates fix-A — the
   prettier diff — 3.4x *worse*, because one open security group
   (`network_exposure` + `public_exposure`) outweighs three scoped IAM grants. It
   prices in the network hole the reviewer glossed over.
2. **The verdict is a knob, not a fact.** The entire gap between A and B *is* the
   network exposure. Discount it and the 3.4x collapses to a 1.6x near-tie. There
   is no universal winner — there's a tradeoff axis, and the tool shows you where
   you sit on it.

## Honest boundary

The tool has no **resource sensitivity** yet: it does not know fix-B's secret is
the crown-jewel license key, or whether fix-A's open port reaches anything
sensitive. So for the deepest question — "is holding *this* secret worse than
opening *that* port?" — it makes the cross-channel tradeoff **legible** and hands
you a **tunable knob**, but it is decision *support*, not a decision *oracle*.
Resource-sensitivity weighting (`PLAN.md` §5) is the missing piece.
