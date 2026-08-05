# exposed-bucket — a feedback edge changes the verdict

This example demonstrates **feedback edge ①** (`reachability → IAM`, see
[`docs/feedback-loops.md`](../../docs/feedback-loops.md)): letting one analyzer's
output sharpen another's, instead of running them in parallel and summing.

## The setup

An analytics role has `s3:*` on a data-lake bucket that has **no public-access
block** — so Checkov flags the bucket publicly reachable and cloudsplaining flags
the policy over-broad. Two people propose different fixes:

| | IAM policy | Bucket exposure |
|---|---|---|
| **fix-A** | narrows `s3:*` → an explicit `Get*/Put*/List*/Delete*` set | **left public** |
| **fix-B** | keeps `s3:*` | **locked down** (adds a public-access block) |

Each fix is better on **one** channel: fix-A on IAM (narrower policy), fix-B on
network (private bucket). Which has the smaller blast radius?

## The point: the answer depends on the interaction

```
$ blast-compare --repo <repo> --base main --a fix-A --b fix-B --no-feedback
   ✅ Smallest blast radius: A (fix-A)  (1.2× smaller than B)

$ blast-compare --repo <repo> --base main --a fix-A --b fix-B
   ✅ Smallest blast radius: B (fix-B)  (1.7× smaller than A)
```

Run the analyzers **in parallel** (`--no-feedback`) and fix-A wins — its policy is
narrower and the fixed public-exposure cost is a flat lump. Turn the **feedback
edge on** (default) and the verdict **flips**: fix-A's ~135 surviving grants all
land on a bucket the whole internet can reach, so each is a live exfiltration /
tamper path, not a latent one. cloudsplaining never knew the bucket was public;
Checkov never knew who could write to it. Only the feedback line sees both.

fix-B's broad `s3:*` looks scarier in isolation, but it's sealed behind a
private bucket — the contained blast radius is smaller.

## Run it

```bash
DEST=$(examples/exposed-bucket/build-repo.sh)
node out/src/compare/cli.js --repo "$DEST" --base main --a fix-A --b fix-B
node out/src/compare/cli.js --repo "$DEST" --base main --a fix-A --b fix-B --no-feedback
rm -rf "$DEST"
```
