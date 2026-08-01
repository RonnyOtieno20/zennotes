#!/usr/bin/env bash
set -euo pipefail

# Rebase the small downstream commit series onto a selected upstream release.
# A conflict intentionally leaves the sync branch and rebase state intact so a
# maintainer can inspect and resolve it without reconstructing the attempt.

upstream_remote="${UPSTREAM_REMOTE:-upstream}"
downstream_branch="${DOWNSTREAM_BRANCH:-grammar-main}"
requested_tag="${1:-}"

fail() {
  printf 'grammar downstream sync: %s\n' "$*" >&2
  exit 1
}

git diff --quiet || fail 'working tree has unstaged changes'
git diff --cached --quiet || fail 'working tree has staged changes'
git remote get-url "$upstream_remote" >/dev/null 2>&1 || \
  fail "remote '$upstream_remote' is not configured"
git show-ref --verify --quiet "refs/heads/$downstream_branch" || \
  fail "branch '$downstream_branch' does not exist"

if [[ -n "$requested_tag" ]]; then
  upstream_tag="$requested_tag"
else
  upstream_tag="$(
    git ls-remote --tags --refs "$upstream_remote" 'v*' \
      | awk -F/ '$3 ~ /^v[0-9]/ { print $3 }' \
      | sort -V \
      | tail -n 1
  )"
fi
[[ -n "$upstream_tag" ]] || fail 'could not discover an upstream release tag'

git fetch --quiet "$upstream_remote" "refs/tags/$upstream_tag:refs/tags/$upstream_tag"
upstream_ref="refs/tags/$upstream_tag"
git rev-parse --verify --quiet "$upstream_ref^{commit}" >/dev/null || \
  fail "upstream tag '$upstream_tag' does not resolve to a commit"

base="$(git merge-base "$downstream_branch" "$upstream_ref")" || \
  fail "'$downstream_branch' has no merge base with '$upstream_tag'"
sync_branch="sync/${upstream_tag#v}"

git switch --quiet -C "$sync_branch" "$downstream_branch"
if ! git rebase --rebase-merges --onto "$upstream_ref" "$base"; then
  printf 'SYNC_BRANCH=%s\n' "$sync_branch"
  printf 'UPSTREAM_TAG=%s\n' "$upstream_tag"
  printf 'CONFLICTED_FILES:\n' >&2
  git diff --name-only --diff-filter=U >&2 || true
  printf 'Resolve the conflicts, run git rebase --continue, then test before pushing.\n' >&2
  exit 1
fi

next_version="$(node scripts/downstream/set-grammar-version.mjs "$upstream_tag")"
git add apps/desktop/package.json package-lock.json
git diff --cached --quiet || \
  git commit -m "Prepare Grammar Edition ${next_version} for ${upstream_tag}"

printf 'SYNC_BRANCH=%s\n' "$sync_branch"
printf 'UPSTREAM_TAG=%s\n' "$upstream_tag"
printf 'DOWNSTREAM_VERSION=%s\n' "$next_version"
