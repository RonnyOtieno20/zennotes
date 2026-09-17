#!/usr/bin/env bash
set -euo pipefail

# Rebase the small downstream commit series onto a selected upstream release.
# A conflict is reported and cleaned up so an automated update cannot strand
# the checkout in a half-completed rebase.

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

# Conflicted package manifests are resolved at hunk level: the upstream side
# of each conflicted hunk wins (version bumps, dependency changes) while
# cleanly merged downstream content - Grammar artifact naming, packaged
# edition metadata, downstream scripts - is preserved. Whole-file
# "git checkout --ours" would silently discard those downstream settings.
prefer_upstream_hunks() {
  awk '
    BEGIN { state = 0 }
    /^<<<<<<< / && state == 0 { state = 1; next }
    /^\|\|\|\|\|\|\| / && state == 1 { state = 2; next }
    /^=======$/ && state == 1 { state = 2; next }
    /^>>>>>>> / && state == 2 { state = 0; next }
    state != 2 { print }
  ' "$1" > "$1.resolved" && mv "$1.resolved" "$1"
}

# Root package.json also carries downstream npm scripts. Re-add any script
# that exists in the downstream commit being replayed but vanished from the
# upstream-resolved merge, so Grammar tooling keeps working after the rebase.
restore_downstream_scripts() {
  node -e '
    const fs = require("node:fs")
    const { execFileSync } = require("node:child_process")
    const path = process.argv[1]
    const merged = JSON.parse(fs.readFileSync(path, "utf8"))
    const downstream = JSON.parse(
      execFileSync("git", ["show", "REBASE_HEAD:package.json"], { encoding: "utf8" })
    )
    merged.scripts = { ...(merged.scripts || {}) }
    for (const [name, command] of Object.entries(downstream.scripts || {})) {
      if (!(name in merged.scripts)) {
        merged.scripts[name] = command
        console.log(`Restored downstream script: ${name}`)
      }
    }
    fs.writeFileSync(path, JSON.stringify(merged, null, 2) + "\n")
  ' "$1"
}

# Every completed sync ends with a generated Grammar Edition version commit.
# That historical version is deliberately replaced after the next rebase, so
# skip it when it is the only thing blocking a newer upstream package version.
rebase_status=0
git rebase --rebase-merges --onto "$upstream_ref" "$base" || rebase_status=$?
while [[ "$rebase_status" -ne 0 ]]; do
  rebase_subject="$(git show -s --format=%s REBASE_HEAD 2>/dev/null || true)"
  mapfile -t conflicted_files < <(git diff --name-only --diff-filter=U)
  metadata_only=true
  [[ "${#conflicted_files[@]}" -gt 0 ]] || metadata_only=false
  for path in "${conflicted_files[@]}"; do
    case "$path" in
      apps/desktop/package.json|package-lock.json|package.json) ;;
      *) metadata_only=false ;;
    esac
  done
  if [[ "$metadata_only" != true ]]; then
    break
  fi

  rebase_status=0
  if [[ "$rebase_subject" == "Prepare Grammar Edition "* ]]; then
    printf 'Skipping obsolete downstream version commit: %s\n' "$rebase_subject"
    git rebase --skip || rebase_status=$?
  else
    printf 'Keeping upstream package metadata while replaying: %s\n' "$rebase_subject"
    for path in "${conflicted_files[@]}"; do
      prefer_upstream_hunks "$path"
      [[ "$path" == "package.json" ]] && restore_downstream_scripts "$path"
      if grep -qE '^(<<<<<<< |>>>>>>> )' "$path"; then
        printf 'could not auto-resolve markers in %s\n' "$path" >&2
        rebase_status=1
        break
      fi
      git add -- "$path"
    done
    if [[ "$rebase_status" -eq 0 ]]; then
      GIT_EDITOR=true git rebase --continue || rebase_status=$?
    fi
  fi
done

if [[ "$rebase_status" -ne 0 ]]; then
  printf 'SYNC_BRANCH=%s\n' "$sync_branch"
  printf 'UPSTREAM_TAG=%s\n' "$upstream_tag"
  printf 'CONFLICTED_FILES:\n' >&2
  git diff --name-only --diff-filter=U >&2 || true
  git rebase --abort >/dev/null 2>&1 || true
  git switch --quiet "$downstream_branch" 2>/dev/null || true
  printf 'The rebase was aborted; %s was left unchanged. Resolve the downstream conflict separately, then retry.\n' "$downstream_branch" >&2
  exit 1
fi

next_version="$(node scripts/downstream/set-grammar-version.mjs "$upstream_tag")"
git add apps/desktop/package.json package-lock.json
git diff --cached --quiet || \
  git commit -m "Prepare Grammar Edition ${next_version} for ${upstream_tag}"

printf 'SYNC_BRANCH=%s\n' "$sync_branch"
printf 'UPSTREAM_TAG=%s\n' "$upstream_tag"
printf 'DOWNSTREAM_VERSION=%s\n' "$next_version"
