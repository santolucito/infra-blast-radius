#!/usr/bin/env bash
# Assemble the messy-baseline example into a throwaway git repo with three
# branches (main / fix-A / fix-B) that `blast-compare` can diff.
#
#   DEST=$(examples/messy-baseline/build-repo.sh)
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
git add -A && git commit -qm "baseline: accreted data-pipeline role (overlapping statements)"

git checkout -q -b fix-A
apply fix-A
git add -A && git commit -qm "fix(A): scope dynamodb:* and drop the redundant Lake statement"

git checkout -q main
git checkout -q -b fix-B
apply fix-B
git add -A && git commit -qm "fix(B): scope s3:* on the lake and the all-secrets read"

git checkout -q main
echo "$DEST"
