#!/usr/bin/env bash
# Assemble the exposed-bucket example into a throwaway git repo with three
# branches (main / fix-A / fix-B) that `blast-compare` can diff. Demonstrates the
# reachability -> IAM feedback edge (docs/feedback-loops.md): fix-A narrows the
# IAM policy but leaves the bucket public; fix-B locks the bucket but keeps the
# broad policy. Which is safer depends on the *interaction*, which only the
# feedback line captures.
#
#   DEST=$(examples/exposed-bucket/build-repo.sh)
#
# Prints the repo path on stdout.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$(mktemp -d)}"
mkdir -p "$DEST"
cd "$DEST"

git init -q
git config user.email demo@example.com
git config user.name  demo

apply() {
  find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -R "$HERE/variants/$1/." .
}

apply baseline
git add -A && git commit -qm "baseline: broad s3:* on a public data lake"

git checkout -q -b fix-A
apply fix-A
git add -A && git commit -qm "fix(A): least-privilege the IAM actions (bucket stays public)"

git checkout -q main
git checkout -q -b fix-B
apply fix-B
git add -A && git commit -qm "fix(B): lock the bucket down (IAM stays broad)"

git checkout -q main
echo "$DEST"
