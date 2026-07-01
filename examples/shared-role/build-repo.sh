#!/usr/bin/env bash
# Assemble the shared-role example into a throwaway git repo with three branches
# (main / fix-A / fix-B) that `blast-compare` can diff.
#
#   DEST=$(examples/shared-role/build-repo.sh)       # build into a temp dir
#   examples/shared-role/build-repo.sh /path/to/repo # or a dir you choose
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

# Replace the whole worktree (except .git) with a variant snapshot.
apply() {
  find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -R "$HERE/variants/$1/." .
}

apply baseline
git add -A && git commit -qm "baseline: reporting job bootstrapped with s3:* (must change)"

git checkout -q -b fix-A
apply fix-A
git add -A && git commit -qm "fix(A): give the job its own least-privilege role"

git checkout -q main
git checkout -q -b fix-B
apply fix-B
git add -A && git commit -qm "fix(B): attach the job to the shared PlatformAccess role"

git checkout -q main
echo "$DEST"
