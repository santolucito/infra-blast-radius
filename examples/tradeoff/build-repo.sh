#!/usr/bin/env bash
# Assemble the cross-channel tradeoff example into a throwaway git repo with three
# branches (main / fix-A / fix-B) that `blast-compare` can diff.
#
#   DEST=$(examples/tradeoff/build-repo.sh)          # build into a temp dir
#   examples/tradeoff/build-repo.sh /path/to/repo    # or a dir you choose
#
# Prints the repo path on stdout so you can capture it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$(mktemp -d)}"
mkdir -p "$DEST"
cd "$DEST"

git init -q
git config user.email demo@example.com
git config user.name  demo

apply() { rm -rf iam infra; cp -R "$HERE/variants/$1/." .; }

apply baseline
git add -A && git commit -qm "baseline: broad IAM (s3:*), locked-down private network"

git checkout -q -b fix-A
apply fix-A
git add -A && git commit -qm "fix(A): scope IAM tightly, but open network to reach license server"

git checkout -q main
git checkout -q -b fix-B
apply fix-B
git add -A && git commit -qm "fix(B): keep network locked, broaden IAM (scoped) to go AWS-native"

git checkout -q main
echo "$DEST"
