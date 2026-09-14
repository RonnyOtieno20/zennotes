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
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/zennotes-grammar-updater"
state_file="$state_dir/last-installed-commit"
lock_file="${XDG_RUNTIME_DIR:-/tmp}/zennotes-grammar-update-${UID}.lock"

exec 9>"$lock_file"
if ! flock -n 9; then
  printf 'Grammar Edition update already running; nothing to do.\n'
  exit 0
fi

git diff --quiet || {
  printf 'grammar update: commit or stash local changes first\n' >&2
  exit 1
}
git diff --cached --quiet || {
  printf 'grammar update: commit or stash staged changes first\n' >&2
  exit 1
}

git fetch --quiet origin grammar-main
git switch --quiet grammar-main
git pull --ff-only origin grammar-main

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
current_commit="$(git rev-parse grammar-main)"
last_installed_commit="$(cat "$state_file" 2>/dev/null || true)"
if git merge-base --is-ancestor "$upstream_tag^{commit}" grammar-main \
  && [[ "$last_installed_commit" == "$current_commit" ]]; then
  printf 'Grammar Edition is already current at %s (%s).\n' \
    "$upstream_tag" "${current_commit:0:12}"
  exit 0
fi

if ! sync_output="$(UPSTREAM_REMOTE="$upstream_remote" DOWNSTREAM_BRANCH=grammar-main \
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

backup_branch="backup/grammar-main-before-${resolved_tag#v}-$(date -u +%Y%m%d%H%M%S)"
git branch "$backup_branch" grammar-main
git push origin "$backup_branch"
git branch -f grammar-main "$sync_branch"
git push --force-with-lease origin grammar-main
git switch --quiet grammar-main

mkdir -p "$state_dir"
installed_commit="$(git rev-parse grammar-main)"
printf '%s\n' "$installed_commit" > "$state_file"

printf 'Grammar Edition updated from %s and installed (%s).\n' "$resolved_tag" "$version"
