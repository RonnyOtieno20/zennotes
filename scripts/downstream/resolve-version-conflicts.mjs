#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

// Every upstream release bumps the desktop version line that the Grammar
// Edition also owns, so that one field conflicts on every merge. It is safe to
// resolve because set-grammar-version.mjs rewrites it right after the merge.
// Anything else stays a manual resolution: a conflicted path outside this list,
// or any difference between the two sides beyond the desktop version, makes
// this script resolve nothing and exit non-zero.

const versionFields = {
  "apps/desktop/package.json": (json) => json,
  "package-lock.json": (json) => json.packages?.["apps/desktop"],
};

const root = process.cwd();

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

// Rebuild one side of a conflicted file from its markers. Handles both the
// default "merge" style and "diff3"/"zdiff3" (which add a ||||||| base part).
function side(source, wanted) {
  const out = [];
  let part = null;
  for (const line of source.split("\n")) {
    if (line.startsWith("<<<<<<< ")) part = "ours";
    else if (line.startsWith("||||||| ") && part === "ours") part = "base";
    else if (line === "=======" && part) part = "theirs";
    else if (line.startsWith(">>>>>>> ") && part === "theirs") part = null;
    else if (part === null || part === wanted) out.push(line);
  }
  if (part !== null) throw new Error("unterminated conflict marker");
  return out.join("\n");
}

function withoutDesktopVersion(relativePath, text) {
  const json = JSON.parse(text);
  const holder = versionFields[relativePath](json);
  if (!holder || typeof holder.version !== "string") {
    throw new Error(`${relativePath}: desktop version field not found`);
  }
  delete holder.version;
  return json;
}

const conflicted = git("diff", "--name-only", "--diff-filter=U")
  .split("\n")
  .filter(Boolean);

if (conflicted.length === 0) {
  console.error("no conflicted paths to resolve");
  process.exit(1);
}

const resolutions = [];
for (const relativePath of conflicted) {
  if (!(relativePath in versionFields)) {
    console.error(`${relativePath}: not a version-only file; resolve by hand`);
    process.exit(1);
  }
  const source = await readFile(path.join(root, relativePath), "utf8");
  const ours = side(source, "ours");
  const theirs = side(source, "theirs");
  if (
    !isDeepStrictEqual(
      withoutDesktopVersion(relativePath, ours),
      withoutDesktopVersion(relativePath, theirs),
    )
  ) {
    console.error(`${relativePath}: conflicts beyond the desktop version; resolve by hand`);
    process.exit(1);
  }
  resolutions.push({ relativePath, theirs });
}

// Only write once every path has been checked, so a refusal leaves the merge
// exactly as Git produced it.
for (const { relativePath, theirs } of resolutions) {
  await writeFile(path.join(root, relativePath), theirs);
  git("add", "--", relativePath);
  console.log(`Resolved desktop version conflict in ${relativePath}.`);
}
