#!/usr/bin/env bash
set -euo pipefail

# One-command personal update path. It never promotes or installs a candidate
# until the rebase, production checks, package verification, and dpkg install
# all succeed. A dated backup branch keeps the prior downstream baseline
# recoverable before the reviewed rebase is promoted.

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

git diff --quiet || {
  printf 'grammar update: commit or stash local changes first\n' >&2
  exit 1
}
git diff --cached --quiet || {
  printf 'grammar update: commit or stash staged changes first\n' >&2
  exit 1
}

git fetch --quiet origin "$downstream_branch"
git switch --quiet "$downstream_branch"
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
