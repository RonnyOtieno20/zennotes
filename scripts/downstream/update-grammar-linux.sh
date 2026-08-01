#!/usr/bin/env bash
set -euo pipefail

# One-command personal update path. It never promotes or installs a candidate
# until the rebase, production checks, package verification, and dpkg install
# all succeed. A dated backup branch keeps the prior downstream baseline
# recoverable before the reviewed rebase is promoted.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

upstream_tag="${1:-}"
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

if ! sync_output="$(UPSTREAM_REMOTE=upstream DOWNSTREAM_BRANCH=grammar-main \
  scripts/downstream/sync-upstream.sh "$upstream_tag" 2>&1)"; then
  printf '%s\n' "$sync_output" >&2
  exit 1
fi
printf '%s\n' "$sync_output"

sync_branch="$(printf '%s\n' "$sync_output" | sed -n 's/^SYNC_BRANCH=//p')"
resolved_tag="$(printf '%s\n' "$sync_output" | sed -n 's/^UPSTREAM_TAG=//p')"
test -n "$sync_branch"
test -n "$resolved_tag"

npm run dist:grammar-linux
version="$(node -p "require('./apps/desktop/package.json').version")"
manifest="dist/ZenNotes-Grammar-${version}-SHA256SUMS.txt"
deb="dist/ZenNotes-Grammar-${version}-linux-amd64.deb"
test -f "$manifest"
test -f "$deb"
(cd dist && sha256sum -c "$(basename "$manifest")")
sudo dpkg -i "$deb"

backup_branch="backup/grammar-main-before-${resolved_tag#v}-$(date -u +%Y%m%d%H%M%S)"
git branch "$backup_branch" grammar-main
git push origin "$backup_branch"
git branch -f grammar-main "$sync_branch"
git push --force-with-lease origin grammar-main
git switch --quiet grammar-main

printf 'Grammar Edition updated from %s and installed (%s).\n' "$resolved_tag" "$version"
