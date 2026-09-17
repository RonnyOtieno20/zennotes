#!/usr/bin/env bash
set -euo pipefail

# One-command personal update path. It never promotes or installs a candidate
# until the upstream merge, production checks, package verification, and dpkg
# install all succeed. A dated backup branch keeps the prior downstream
# baseline recoverable before the reviewed merge is promoted.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

upstream_tag="${1:-}"
upstream_remote="${UPSTREAM_REMOTE:-upstream}"
downstream_branch="grammar-main"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/zennotes-grammar-updater"
state_file="$state_dir/last-installed-commit"
lock_file="${XDG_RUNTIME_DIR:-/tmp}/zennotes-grammar-update-${UID}.lock"

exec 9>"$lock_file"
if ! flock -n 9; then
  printf 'Grammar Edition update already running; nothing to do.\n'
  exit 0
fi

starting_branch="$(git branch --show-current)"
recovery_dir=""
stash_ref=""

# Keep the one-command contract meaningful even when a developer left a local
# edit in the checkout. The edit is captured in a dated recovery directory and
# a temporary stash, then restored to the original branch after the update.
# This avoids asking the user to make a manual stash/merge decision while still
# preserving every staged, unstaged, and untracked file.
stash_local_changes() {
  if [[ -z "$(git status --porcelain)" ]]; then
    return 0
  fi

  recovery_dir="$(dirname "$root")/recovery/zennotes-update-$(date -u +%Y%m%d%H%M%S)-$$"
  mkdir -p "$recovery_dir"
  git status --short > "$recovery_dir/status.txt"
  git diff --cached --output="$recovery_dir/staged.patch"
  git diff --output="$recovery_dir/unstaged.patch"
  git ls-files --others --exclude-standard -z > "$recovery_dir/untracked.list"
  git stash push --include-untracked --message "zennotes grammar updater automatic snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
  # Git's stash porcelain expects a stash selector, not the raw commit hash.
  # No other stash operation runs during the update, so stash@{0} remains
  # stable until this snapshot is reapplied and dropped.
  stash_ref="stash@{0}"
  printf 'grammar update: local changes saved to %s\n' "$recovery_dir" >&2
}

restore_local_changes() {
  [[ -n "$stash_ref" ]] || return 0

  restore_branch="$starting_branch"
  if [[ -z "$restore_branch" ]] || \
    ! git show-ref --verify --quiet "refs/heads/$restore_branch"; then
    restore_branch="$downstream_branch"
  fi
  git switch --quiet "$restore_branch"
  if ! git stash apply --index "$stash_ref"; then
    printf 'grammar update: local changes could not be reapplied automatically; stash retained as %s\n' \
      "$stash_ref" >&2
    printf 'grammar update: recovery snapshot is %s\n' "$recovery_dir" >&2
    return 1
  fi
  if ! git stash drop "$stash_ref" >/dev/null; then
    printf 'grammar update: restored local changes but could not drop %s; it was retained\n' \
      "$stash_ref" >&2
    return 1
  fi
  printf 'grammar update: local changes restored on %s\n' "$restore_branch" >&2
}

on_exit() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    git merge --abort >/dev/null 2>&1 || true
    git rebase --abort >/dev/null 2>&1 || true
    git switch --quiet "$downstream_branch" >/dev/null 2>&1 || true
  fi
  if ! restore_local_changes; then
    status=1
  fi
  return "$status"
}
trap on_exit EXIT

rebase_dir="$(git rev-parse --git-path rebase-merge)"
apply_dir="$(git rev-parse --git-path rebase-apply)"
if [[ -d "$rebase_dir" || -d "$apply_dir" ]]; then
  active_rebase_dir="$rebase_dir"
  [[ -d "$active_rebase_dir" ]] || active_rebase_dir="$apply_dir"
  active_branch="$(sed -n '1p' "$active_rebase_dir/head-name" 2>/dev/null || true)"

  case "$active_branch" in
    refs/heads/sync/*)
      recovery_dir="$(dirname "$root")/recovery/zennotes-update-$(date -u +%Y%m%d%H%M%S)"
      mkdir -p "$recovery_dir"
      git status --short > "$recovery_dir/status.txt"
      git diff --cached --output="$recovery_dir/staged.patch"
      git diff --output="$recovery_dir/unstaged.patch"
      git diff --cc --output="$recovery_dir/conflicts.patch" || true
      for metadata_file in head-name onto done git-rebase-todo; do
        test -f "$active_rebase_dir/$metadata_file" && \
          cp "$active_rebase_dir/$metadata_file" "$recovery_dir/$metadata_file"
      done
      git rebase --abort
      git switch --quiet "$downstream_branch"
      printf 'grammar update: recovered interrupted sync rebase; snapshot saved to %s\n' \
        "$recovery_dir" >&2
      ;;
    *)
      printf 'grammar update: another Git rebase is active; refusing to alter it automatically\n' >&2
      exit 1
      ;;
  esac
fi

stash_local_changes
git switch --quiet "$downstream_branch"

git fetch --quiet origin "$downstream_branch"
git pull --ff-only origin "$downstream_branch"

if [[ -z "$upstream_tag" ]]; then
  upstream_tag="$(
    git ls-remote --tags --refs "$upstream_remote" 'v*' \
      | awk -F/ '$3 ~ /^v[0-9]/ { print $3 }' \
      | sort -V \
      | tail -n 1
  )"
fi
[[ -n "$upstream_tag" ]] || {
  printf 'grammar update: could not discover an upstream release tag\n' >&2
  exit 1
}

git fetch --quiet "$upstream_remote" "refs/tags/$upstream_tag:refs/tags/$upstream_tag"
current_commit="$(git rev-parse "$downstream_branch")"
last_installed_commit="$(cat "$state_file" 2>/dev/null || true)"
if git merge-base --is-ancestor "$upstream_tag^{commit}" "$downstream_branch" \
  && [[ "$last_installed_commit" == "$current_commit" ]]; then
  printf 'Grammar Edition is already current at %s (%s).\n' \
    "$upstream_tag" "${current_commit:0:12}"
  exit 0
fi

if ! sync_output="$(UPSTREAM_REMOTE="$upstream_remote" DOWNSTREAM_BRANCH="$downstream_branch" \
  scripts/downstream/sync-upstream.sh "$upstream_tag" 2>&1)"; then
  printf '%s\n' "$sync_output" >&2
  exit 1
fi
printf '%s\n' "$sync_output"

sync_branch="$(printf '%s\n' "$sync_output" | sed -n 's/^SYNC_BRANCH=//p')"
resolved_tag="$(printf '%s\n' "$sync_output" | sed -n 's/^UPSTREAM_TAG=//p')"
test -n "$sync_branch"
test -n "$resolved_tag"

corepack npm run dist:grammar-linux
version="$(node -p "require('./apps/desktop/package.json').version")"
manifest="dist/ZenNotes-Grammar-${version}-SHA256SUMS.txt"
deb="dist/ZenNotes-Grammar-${version}-linux-amd64.deb"
test -f "$manifest"
test -f "$deb"
(cd dist && sha256sum -c "$(basename "$manifest")")
sudo -n dpkg -i "$deb"

backup_branch="backup/${downstream_branch}-before-${resolved_tag#v}-$(date -u +%Y%m%d%H%M%S)"
git branch "$backup_branch" "$downstream_branch"
git push origin "$backup_branch"
git branch -f "$downstream_branch" "$sync_branch"
git push --force-with-lease origin "$downstream_branch"
git switch --quiet "$downstream_branch"

mkdir -p "$state_dir"
installed_commit="$(git rev-parse "$downstream_branch")"
printf '%s\n' "$installed_commit" > "$state_file"

printf 'Grammar Edition updated from %s and installed (%s).\n' "$resolved_tag" "$version"
