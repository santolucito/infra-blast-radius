# Example: a messy baseline where the diff lies

The other examples start from a clean baseline. Real policies are not clean — they
accrete. This example is an `analytics-role` with **five overlapping statements**
whose intent is genuinely hard to read, and two plausible "least-privilege
cleanups". The catch: **you cannot rank the fixes from the diff, because each one
interacts with statements that are already there.** Only computing the _effective_
allowed-action set before and after tells the truth — which is exactly what the
tool scores.

## The accreted baseline

```
LakeFull    s3:*                          on pipeline-lake/*      # legacy "just make it work"
LakeExtra   s3:Get/Put/List/Delete/       on pipeline-lake/*      # added later; overlaps LakeFull
              PutBucketPolicy
Warehouse   dynamodb:*                    on table/analytics-*    # broad
Secrets     secretsmanager:GetSecretValue on *                   # reads ALL secrets
Keys        kms:Decrypt                   on *                   # decrypts everything
```

Effective allowed actions: **248**.

## Two cleanups — each with a whole-policy gotcha

**fix-A** — "scope the warehouse, drop the redundant Lake statement." Looks like a
big cleanup (removes a whole statement, scopes `dynamodb:*`). But deleting
`LakeExtra` changes **nothing** — `LakeFull`'s `s3:*` already grants everything it
did. `s3` stays fully broad; the only real reduction is DynamoDB.

**fix-B** — "scope `s3:*` on the lake and the all-secrets read." A smaller-looking
diff (two statements edited), but it cuts the two biggest wildcards. **Except**:
it leaves `LakeExtra` untouched, so `s3:DeleteObject` and **`s3:PutBucketPolicy`**
(a permissions-management action — rewrite the bucket policy) **still leak** onto
the lake. fix-B's "s3 is now read/write only" is simply false.

## Run it

```bash
npm run compile
pipx install cloudsplaining
DEST=$(examples/messy-baseline/build-repo.sh)
node dist/cli.js --repo "$DEST" --base main --ref:A fix-A --ref:B fix-B --no-checkov
```

## What you should see

```
baseline (main): score 498      (248 effective allowed actions)
A (fix-A)   score 323  (-175)   (173 effective — s3:* untouched, dynamodb scoped)
B (fix-B)   score 195  (-303)   ( 85 effective — s3 + secrets scoped, but leaks PutBucketPolicy)
✅ Smallest blast radius: B (fix-B) — 1.7× smaller than A
```

The verdict is close (1.7×) and genuinely debatable:

- **fix-A** keeps `s3:*` on the lake and reads on **all** secrets, but is otherwise
  clean (no shadow leaks, DynamoDB scoped).
- **fix-B** cuts far more effective access, but its lake scoping is undermined by a
  leftover statement — `PutBucketPolicy`/`DeleteObject` still leak, and
  `dynamodb:*` is untouched.

The point is not which one wins — it is that **the diff cannot tell you.**
fix-A _looks_ like the bigger cleanup (it deletes a statement) while doing less;
fix-B _looks_ like a small edit while cutting more, yet quietly leaves a
permissions-management action granted. The tool scores the effective union across
all five statements, so redundant deletions score as no-ops and shadow leaks are
still counted — the things a human reading two diffs will miss.
