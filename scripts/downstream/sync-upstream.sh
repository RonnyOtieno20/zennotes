#!/usr/bin/env bash
set -euo pipefail

# Merge a selected upstream release into the maintained Grammar Edition branch.
# The first Grammar Edition migration was intentionally a large tree transplant,
# so replaying it with rebase would rediscover the same conflicts on every
# release. A merge uses Git's real common ancestor instead: upstream changes in
# unrelated hunks are retained. A conflicting hunk stops the sync for a human to
# resolve; it is never auto-resolved in either direction.

upstream_remote="${UPSTREAM_REMOTE:-upstream}"
downstream_branch="${DOWNSTREAM_BRANCH:-grammar-main}"
requested_tag="${1:-}"
sync_branch=""

fail() {
  printf 'grammar downstream sync: %s\n' "$*" >&2
  exit 1
}

# Never leave a caller stranded on a candidate branch or inside an unfinished
# merge if a fetch, merge, version update, or commit fails.
on_error() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    git merge --abort >/dev/null 2>&1 || true
    git rebase --abort >/dev/null 2>&1 || true
    git switch --quiet "$downstream_branch" >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap on_error EXIT

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
      | awk -F/ '{ print $3 }' \
      | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
      | sort -V \
      | tail -n 1
  )"
fi
[[ -n "$upstream_tag" ]] || \
  fail "no release tag matching vX.Y.Z found on remote '$upstream_remote'"

git fetch --quiet "$upstream_remote" "refs/tags/$upstream_tag:refs/tags/$upstream_tag"
upstream_ref="refs/tags/$upstream_tag"
git rev-parse --verify --quiet "$upstream_ref^{commit}" >/dev/null || \
  fail "upstream tag '$upstream_tag' does not resolve to a commit"

sync_branch="sync/${upstream_tag#v}"
git switch --quiet -C "$sync_branch" "$downstream_branch"

# If the release is already part of the downstream branch, there is no code
# merge to perform; this is the normal case when only the Grammar package
# version needs to advance. Otherwise merge the release as a plain merge.
# Conflicts are never resolved automatically: a conflicting hunk silently
# dropping either side is how upstream fixes get lost, so the merge is aborted
# and the conflicted paths are reported for a manual resolution.
merge_performed=false
if ! git merge-base --is-ancestor "$upstream_ref" "$sync_branch"; then
  merge_performed=true
  merge_status=0
  GIT_EDITOR=true git merge --no-edit --no-ff "$upstream_ref" || merge_status=$?
  if [[ "$merge_status" -ne 0 ]]; then
    conflicted_files="$(git diff --name-only --diff-filter=U)"
    git merge --abort >/dev/null 2>&1 || true
    if [[ -z "$conflicted_files" ]]; then
      fail "merge of $upstream_tag failed without conflict paths"
    fi

    printf 'grammar downstream sync: merging %s conflicts in these files:\n' "$upstream_tag" >&2
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      printf '  %s\n' "$path" >&2
    done <<< "$conflicted_files"
    fail "$downstream_branch was left unchanged; merge $upstream_tag by hand and resolve these conflicts"
  fi
fi

# Some upstream structural edits can merge textually while dropping the
# declarations that newer call sites depend on. Reconcile upstream-owned
# panel/capability blocks after the merge, preserving the Grammar Edition's
# state and provider capability.
node scripts/downstream/reconcile-grammar-upstream.mjs "$upstream_ref"

next_version="$(node scripts/downstream/set-grammar-version.mjs "$upstream_tag")"
git add \
  apps/desktop/package.json \
  package-lock.json \
  packages/app-core/src/components/EditorPane.tsx \
  packages/bridge-contract/src/bridge.ts \
  apps/desktop/src/preload/index.ts
git diff --cached --quiet || \
  git commit -m "Prepare Grammar Edition ${next_version} for ${upstream_tag}"

printf 'SYNC_BRANCH=%s\n' "$sync_branch"
printf 'UPSTREAM_TAG=%s\n' "$upstream_tag"
printf 'DOWNSTREAM_VERSION=%s\n' "$next_version"
printf 'MERGE_PERFORMED=%s\n' "$merge_performed"
