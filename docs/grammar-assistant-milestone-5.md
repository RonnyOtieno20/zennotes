# Grammar assistant — Milestone 5

Milestone 5 turns the grammar work into a small, maintainable downstream
edition. It is deliberately packaged as **ZenNotes Grammar Edition** while
retaining ZenNotes' application ID and data locations. Existing vaults and
preferences therefore continue to work, but the packaged edition carries an
explicit updater policy that prevents the official ZenNotes updater from
replacing it with a stock build.

The application version reserves the next upstream patch number, such as
`2.20.3-grammar.1` for upstream `2.20.2`. electron-builder translates that to
the Debian version `2.20.3~grammar.1`, which is newer than the installed stock
package and therefore lets `dpkg` upgrade a normal ZenNotes installation.
When upstream releases the reserved patch, advance the downstream base patch
before building the next Grammar Edition package.

## Update policy

The package includes `resources/downstream-edition.json`. At startup the
desktop updater validates that metadata before it configures `electron-updater`.
For the Grammar Edition the policy is `disabled`, so an in-app check reports
that updates arrive through downstream packages instead of downloading an
official ZenNotes release.

This only protects the in-app updater. Installing a stock ZenNotes `.deb`
manually can still replace this package because the downstream edition retains
the package and application identities for data compatibility. Install updates
from the Grammar Edition release workflow instead.

## Build a Linux package

From the repository root, run:

```bash
npm run dist:grammar-linux
```

The command runs the production typecheck, test suite, and build, then creates
only an AppImage and Debian package. It passes `SOURCE_DATE_EPOCH` from the
current commit when the environment does not already set it, making package
inputs stable for a given commit. The output includes:

- `dist/ZenNotes-Grammar-<version>-linux-*.deb`
- `dist/ZenNotes-Grammar-<version>-linux-*.AppImage`
- `dist/ZenNotes-Grammar-<version>-SHA256SUMS.txt`

The build script checks that both installation formats exist, that the Debian
metadata version equals `apps/desktop/package.json`, and that the Debian payload
contains the downstream updater-policy resource.

Install the Debian artifact with `sudo dpkg -i <artifact>.deb`. Check the
manifest before installing with `sha256sum -c <manifest>` from `dist/`.

After the one-time fork setup below, ordinary updates use just this command:

```bash
scripts/downstream/update-grammar-linux.sh
```

It finds the newest upstream release, makes a `sync/<version>` branch, checks
and packages it, verifies the checksum, installs the Debian package, and then
promotes the tested branch to `grammar-main`. Before that promotion it pushes a
dated `backup/grammar-main-before-...` branch, so the prior edition remains
recoverable. Pass an upstream tag, such as `v2.20.3`, as the first argument to
target a specific release.

## Branches and upstream sync

Use a personal GitHub fork for the downstream repository and configure:

```bash
git remote rename origin upstream
git remote add origin <your-fork-url>
git switch -c upstream-main upstream/main
git switch -c grammar-main
git push -u origin grammar-main upstream-main
```

Keep grammar changes as focused commits on `grammar-main`. Do not add unrelated
formatting or product changes to those commits. For each upstream release, the
sync process creates `sync/<upstream-version>` and rebases the downstream series
onto the upstream tag:

```bash
UPSTREAM_REMOTE=upstream DOWNSTREAM_BRANCH=grammar-main \
  scripts/downstream/sync-upstream.sh v2.20.2
```

The script refuses a dirty worktree or missing branch/remote. On a conflict it
leaves the rebase state and `sync/<version>` branch in place, prints the
conflicted paths, and exits non-zero. Resolve normally with `git add ...` and
`git rebase --continue`; then run `npm run dist:grammar-linux` before review.

After a clean rebase, the script creates one focused commit that sets the
desktop package to the next patch version with `-grammar.1` (for example,
upstream `v2.20.3` becomes `2.20.4-grammar.1`). This keeps every downstream
Debian package newer than the upstream release it contains.

## GitHub automation

`Grammar Edition upstream sync` runs weekly and can be started manually with a
specific upstream tag. It resolves the latest official ZenNotes release,
rebases onto it, runs the same production packaging command, uploads candidate
artifacts, and pushes the resulting `sync/<version>` branch for review.

If a rebase conflicts, it stops before tests, packaging, branch push, or
publication. It creates one actionable issue per blocked upstream tag containing
the conflicted files and a local reproduction command.

`Grammar Edition release` is manual by design. Give it a tested `grammar-main`
or reviewed sync branch and a `grammar-v...` tag. It rebuilds artifacts, uploads
them to the workflow, and creates a **draft** GitHub release. Publishing that
draft remains a human decision after installation and smoke testing.

## UI consistency

The inline grammar suggestion card is now styled from the same markup for both
hover and keyboard/click activation. CodeMirror mounts hover cards inside a
generic hover wrapper, while keyboard/click cards are their own tooltip root;
the stylesheet explicitly handles both hosts so the richer pressed card design
is used consistently.
