#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const upstreamRef = process.argv[2];
if (!upstreamRef) {
  throw new Error("usage: reconcile-grammar-upstream.mjs <upstream-tag-ref>");
}

const root = process.cwd();

function showUpstream(relativePath) {
  return execFileSync("git", ["show", `${upstreamRef}:${relativePath}`], {
    cwd: root,
    encoding: "utf8",
  });
}

function blockAt(source, marker, nextLineMarker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`could not find block marker: ${marker}`);
  const end = source.indexOf(nextLineMarker, start);
  if (end < 0) throw new Error(`could not find block end after: ${marker}`);
  return { start, end, text: source.slice(start, end) };
}

function interfaceBlock(source, name) {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`could not find interface ${name}`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`could not find end of interface ${name}`);
  return { start, end: end + 2, text: source.slice(start, end + 2) };
}

function objectBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`could not find object block: ${marker}`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`could not find end of object block: ${marker}`);
  return { start, end: end + 2, text: source.slice(start, end + 2) };
}

const editorPath = "packages/app-core/src/components/EditorPane.tsx";
let editor = await readFile(path.join(root, editorPath), "utf8");
const upstreamEditor = showUpstream(editorPath);
const panelMarker = "  // One sticky set per pane, or one per note when";
const legacyPanelMarker =
  "  const [connectionsOpen, setConnectionsOpen] = useState(false)";
const outlineStateMarker = "  const [activeOutlineLine, setActiveOutlineLine]";
let reconciledPanelState = false;

if (upstreamEditor.includes(panelMarker)) {
  const upstreamPanel = blockAt(
    upstreamEditor,
    panelMarker,
    outlineStateMarker,
  );
  const candidateMarker = editor.includes(panelMarker)
    ? panelMarker
    : legacyPanelMarker;
  const candidatePanel = blockAt(editor, candidateMarker, outlineStateMarker);
  const grammarState = `  const [grammarReviewOpen, setGrammarReviewOpen] = useState(false)\n  const [grammarSessionState, setGrammarSessionState] =\n    useState<GrammarDocumentSessionState | null>(null)\n`;
  const requiredUpstreamImports = [
    "import { usePanePanels } from '../lib/use-pane-panels'",
    "bumpSidePanel",
    "type SidePanelId",
  ];
  for (const requiredImport of requiredUpstreamImports) {
    if (
      upstreamEditor.includes(requiredImport) &&
      !editor.includes(requiredImport)
    ) {
      throw new Error(
        `merged editor is missing upstream panel import: ${requiredImport}`,
      );
    }
  }
  const replacement = `${upstreamPanel.text}${grammarState}`;
  editor = `${editor.slice(0, candidatePanel.start)}${replacement}${editor.slice(candidatePanel.end)}`;
  reconciledPanelState = true;
}

const bridgePath = "packages/bridge-contract/src/bridge.ts";
let bridge = await readFile(path.join(root, bridgePath), "utf8");
const upstreamBridge = showUpstream(bridgePath);
const currentCapabilities = interfaceBlock(bridge, "ZenCapabilities");
const upstreamCapabilities = interfaceBlock(upstreamBridge, "ZenCapabilities");
const grammarTransport =
  /\n  \/\*\* Host-mediated provider transport;[^\n]*\n  supportsGrammarProviderTransport\?: boolean\n/;
const grammarTransportText =
  currentCapabilities.text.match(grammarTransport)?.[0] ?? "";
let mergedCapabilities = upstreamCapabilities.text;
if (
  grammarTransportText &&
  !mergedCapabilities.includes("supportsGrammarProviderTransport")
) {
  const close = mergedCapabilities.lastIndexOf("\n}");
  mergedCapabilities = `${mergedCapabilities.slice(0, close)}${grammarTransportText.trimEnd()}\n${mergedCapabilities.slice(close + 1)}`;
}
bridge = `${bridge.slice(0, currentCapabilities.start)}${mergedCapabilities}${bridge.slice(currentCapabilities.end)}`;

const preloadPath = "apps/desktop/src/preload/index.ts";
let preload = await readFile(path.join(root, preloadPath), "utf8");
const upstreamPreload = showUpstream(preloadPath);
const currentDesktopCapabilities = objectBlock(
  preload,
  "const DESKTOP_CAPABILITIES: ZenCapabilities = {",
);
const upstreamDesktopCapabilities = objectBlock(
  upstreamPreload,
  "const DESKTOP_CAPABILITIES: ZenCapabilities = {",
);
const preservesGrammarTransport = currentDesktopCapabilities.text.includes(
  "supportsGrammarProviderTransport:",
);
let mergedDesktopCapabilities = upstreamDesktopCapabilities.text;
if (
  preservesGrammarTransport &&
  !mergedDesktopCapabilities.includes("supportsGrammarProviderTransport:")
) {
  const close = mergedDesktopCapabilities.lastIndexOf("\n}");
  const prefix = mergedDesktopCapabilities.slice(0, close).trimEnd();
  const withSeparator = prefix.endsWith(",") ? prefix : `${prefix},`;
  mergedDesktopCapabilities = `${withSeparator}\n  supportsGrammarProviderTransport: true${mergedDesktopCapabilities.slice(close)}`;
}
preload = `${preload.slice(0, currentDesktopCapabilities.start)}${mergedDesktopCapabilities}${preload.slice(currentDesktopCapabilities.end)}`;

await Promise.all([
  writeFile(path.join(root, editorPath), editor),
  writeFile(path.join(root, bridgePath), bridge),
  writeFile(path.join(root, preloadPath), preload),
]);

if (reconciledPanelState) {
  console.log(`Reconciled Grammar Edition panel state with ${upstreamRef}.`);
}
console.log(`Reconciled desktop capabilities with ${upstreamRef}.`);
