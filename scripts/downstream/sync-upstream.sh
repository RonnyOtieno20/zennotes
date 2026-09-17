#!/usr/bin/env bash
set -euo pipefail

# Merge a selected upstream release into the maintained Grammar Edition branch.
# The first Grammar Edition migration was intentionally a large tree transplant,
# so replaying it with rebase would rediscover the same conflicts on every
# release. A merge uses Git's real common ancestor instead: upstream changes in
# unrelated hunks are retained, while a conflicting hunk keeps the working
# Grammar Edition implementation. The result is deterministic and reviewable.

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

sync_branch="sync/${upstream_tag#v}"
git switch --quiet -C "$sync_branch" "$downstream_branch"

# If the release is already part of the downstream branch, there is no code
# merge to perform; this is the normal case when only the Grammar package
# version needs to advance. Otherwise merge the release with the downstream
# branch as ours. Git's -X ours is hunk-level (not whole-file), so
# non-conflicting upstream improvements still come across automatically.
merge_performed=false
if ! git merge-base --is-ancestor "$upstream_ref" "$sync_branch"; then
  merge_performed=true
  merge_status=0
  GIT_EDITOR=true git merge --no-edit --no-ff -X ours "$upstream_ref" || merge_status=$?
  if [[ "$merge_status" -ne 0 ]]; then
    conflicted_files="$(git diff --name-only --diff-filter=U)"
    if [[ -z "$conflicted_files" ]]; then
      git merge --abort >/dev/null 2>&1 || true
      fail 'upstream merge failed without conflict paths'
    fi

    printf 'Auto-resolving remaining upstream conflicts in favor of Grammar Edition files:\n' >&2
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      if git cat-file -e ":2:$path" 2>/dev/null; then
        git checkout --ours -- "$path"
      else
        # If the downstream side deleted the path, retain an upstream addition.
        git checkout --theirs -- "$path"
      fi
      git add -- "$path"
      printf '  %s\n' "$path" >&2
    done <<< "$conflicted_files"
    if git diff --name-only --diff-filter=U | grep -q .; then
      fail 'automatic upstream merge resolution left unmerged paths'
    fi
    GIT_EDITOR=true git commit --no-edit
  fi
fi

next_version="$(node scripts/downstream/set-grammar-version.mjs "$upstream_tag")"
git add apps/desktop/package.json package-lock.json
git diff --cached --quiet || \
  git commit -m "Prepare Grammar Edition ${next_version} for ${upstream_tag}"

printf 'SYNC_BRANCH=%s\n' "$sync_branch"
printf 'UPSTREAM_TAG=%s\n' "$upstream_tag"
printf 'DOWNSTREAM_VERSION=%s\n' "$next_version"
printf 'MERGE_PERFORMED=%s\n' "$merge_performed"
