// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteMeta } from "@shared/ipc";
import type {
  CloudSyncConflict,
  CloudSyncRunSummary,
} from "@zennotes/bridge-contract/cloud-sync";
import {
  clearCloudSyncStatus,
  useCloudSyncStatusStore,
} from "../lib/cloud-auto-sync";
import { useStore } from "../store";
import { Preview } from "./Preview";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const notePath = "inbox/Media.md";
const note = {
  path: notePath,
  title: "Media",
  folder: "inbox",
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 0,
  tags: [],
  wikilinks: [],
  assetEmbeds: [],
  hasAttachments: false,
  excerpt: "",
} as NoteMeta;

const markdown = [
  "# Media",
  "",
  "![[assets/clip.mp4]]",
  "",
  "![[assets/song.mp3]]",
  "",
  "![[assets/pic.png]]",
  "",
  "![[assets/doc.pdf]]",
  "",
  "![](assets/archive.zip)",
  "",
  "![](assets/other.mp4)",
].join("\n");

const NOTICE =
  "Not synced to Cloud: larger than the 10 MB file-size limit, so it stays on this device.";

function tooLarge(path: string): CloudSyncConflict {
  return {
    operation_id: `op-${path}`,
    item_id: `item-${path}`,
    code: "FILE_SIZE_LIMIT_EXCEEDED",
    current_revision: null,
    current_path: null,
    path,
    capacity: {
      dimension: "sync_max_file_bytes",
      used: 0,
      reserved: 0,
      limit: 10_000_000,
      projected: 30_000_000,
      can_retry_after_reduction: true,
    },
  };
}

function run(...conflicts: CloudSyncConflict[]): CloudSyncRunSummary {
  return {
    cursor: 1,
    pulled: 0,
    pushed: 0,
    bootstrap_conflicts: [],
    local_conflicts: [],
    conflicts,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`preview never showed ${what}`);
}

function embed(host: HTMLElement, href: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    `[data-local-asset-href="${href}"]:not(a)`,
  );
}

function noticeHosts(host: HTMLElement): string[] {
  return [...host.querySelectorAll("[data-cloud-sync-notice]")].map(
    (el) => (el.parentElement as HTMLElement).dataset.localAssetHref ?? "",
  );
}

describe("Preview: embeds Cloud keeps on this device", () => {
  let host: HTMLElement;
  let unmount: () => void;

  beforeEach(async () => {
    clearCloudSyncStatus();
    if (!globalThis.CSS?.escape) {
      vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^\w-]/g, "\\$&") });
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    Object.defineProperty(window, "zen", {
      configurable: true,
      value: {
        getAppInfo: () => ({ runtime: "web" }),
        readNote: async () => ({ ...note, body: markdown }),
        resolveVaultAssetUrl: (_root: string, rel: string) => `zen-asset://vault/${rel}`,
        resolveLocalAssetUrl: (_root: string, _note: string, href: string) =>
          `zen-asset://note/${href}`,
      },
    });
    useStore.setState({
      notes: [note],
      vault: { root: "/vault", name: "Vault" } as never,
      assetFiles: [
        "assets/clip.mp4",
        "assets/song.mp3",
        "assets/pic.png",
        "assets/doc.pdf",
        "assets/archive.zip",
        "assets/other.mp4",
      ].map((path) => ({ path })) as never,
    });
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(Preview, { markdown, notePath })));
    unmount = () => {
      act(() => root.unmount());
      host.remove();
    };
    await waitFor(() => embed(host, "assets/clip.mp4") !== null, "the media");
  });

  afterEach(() => {
    unmount();
    clearCloudSyncStatus();
    useStore.setState({ notes: [], vault: null, assetFiles: [] });
    delete (window as unknown as { zen?: unknown }).zen;
  });

  it("plays ![](clip.mp4) where it stands, as it plays ![[clip.mp4]]", () => {
    for (const href of ["assets/clip.mp4", "assets/other.mp4"]) {
      const figure = embed(host, href)!;
      expect(figure.classList.contains("local-asset-embed")).toBe(true);
      expect(figure.dataset.localAssetKind).toBe("video");
      expect(figure.querySelector("video")?.getAttribute("src")).toBe(
        `zen-asset://vault/${href}`,
      );
    }
    // A file with nothing to play is still a chip.
    expect(embed(host, "assets/archive.zip")?.classList.contains("local-file-attachment")).toBe(true);
  });

  it("says so under the oversized embed only, and drops it when the summary clears", async () => {
    act(() => {
      useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge("assets/clip.mp4")) });
    });
    await waitFor(() => noticeHosts(host).length > 0, "the notice");

    expect(noticeHosts(host)).toEqual(["assets/clip.mp4"]);
    const notice = host.querySelector("[data-cloud-sync-notice]")!;
    expect(notice.textContent).toBe(NOTICE);
    expect(notice.previousElementSibling?.tagName).toBe("VIDEO");

    act(() => {
      useCloudSyncStatusStore.setState({ lastSummary: null });
    });
    await waitFor(() => noticeHosts(host).length === 0, "the notice gone");
    expect(embed(host, "assets/clip.mp4")?.querySelector("video")).not.toBeNull();
  });

  it("is on image, video, audio, PDF and attachment-chip embeds alike", async () => {
    act(() => {
      useCloudSyncStatusStore.setState({
        lastSummary: run(
          tooLarge("assets/clip.mp4"),
          tooLarge("assets/song.mp3"),
          tooLarge("assets/pic.png"),
          tooLarge("assets/doc.pdf"),
          tooLarge("assets/archive.zip"),
          tooLarge("assets/other.mp4"),
        ),
      });
    });
    await waitFor(() => noticeHosts(host).length === 6, "six notices");

    expect(noticeHosts(host)).toEqual([
      "assets/clip.mp4",
      "assets/song.mp3",
      "assets/pic.png",
      "assets/doc.pdf",
      "assets/archive.zip",
      "assets/other.mp4",
    ]);
    const kinds = [...host.querySelectorAll("[data-cloud-sync-notice]")].map(
      (el) => (el.parentElement as HTMLElement).dataset.localAssetKind,
    );
    expect(kinds).toEqual(["video", "audio", "image", "pdf", "file", "video"]);
  });

  it("does not render the note again for a run that leaves no file over the limit", async () => {
    const video = embed(host, "assets/clip.mp4")!.querySelector("video");
    act(() => {
      useCloudSyncStatusStore.setState({ lastSummary: run() });
    });
    act(() => {
      useCloudSyncStatusStore.setState({
        lastSummary: run({
          operation_id: "op-rev",
          item_id: "rev",
          code: "REVISION_CONFLICT",
          current_revision: 2,
          current_path: null,
          path: notePath,
        }),
      });
    });
    await settle();
    await settle();

    expect(noticeHosts(host)).toEqual([]);
    expect(embed(host, "assets/clip.mp4")!.querySelector("video")).toBe(video);
  });
});
