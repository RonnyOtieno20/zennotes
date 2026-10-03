import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CloudAccountStatus,
  CloudBackupItemsPage,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudPublishedNote,
  CloudServiceAccount,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncVault,
  CloudUsage,
  CloudVaultLink,
} from "@zennotes/bridge-contract/cloud-sync";
import { getZenBridge, type ZenBridge } from "@zennotes/bridge-contract/bridge";
import { confirmApp } from "../lib/confirm-requests";
import {
  clearRemovedCloudVault,
  cloudSyncAttentionItems,
  cloudSyncAttentionLabel,
  cloudVaultGoneReason,
  cloudVaultRemovalLabel,
  cloudVaultRemovalMessage,
  formatCloudBytes,
  cloudSyncAttentionMessage,
  markCloudVaultDeleted,
  openCloudSettingsConflictPrompt,
  refreshCloudSettingsConflict,
  resolveCloudSettingsConflictWithStatus,
  useCloudSyncStatusStore,
  requestCloudAutoSync,
  syncCloudVaultWithStatus,
  type CloudVaultRemoval,
} from "../lib/cloud-auto-sync";
import {
  describeVaultSettingsConflict,
  VAULT_SETTINGS_SECTION_LABELS,
} from "../lib/vault-settings-conflict";
import { useToastStore } from "../lib/toast";
import { notifyPublishedNoteChanged } from "../lib/published-note-events";
import { requestPublishNote } from "../lib/publish-note-requests";
import { Button } from "./ui/Button";
import { useStore } from "../store";
import { focusEditorNormalMode } from "../lib/editor-focus";
import { CloudPendingConflictResolver } from "./CloudPendingConflictResolver";
import { CloudVaultDeleteDialog } from "./CloudVaultDeleteDialog";

type CloudAction =
  | "connect"
  | "logout"
  | "link"
  | "unlink"
  | "vault-delete"
  | "sync"
  | "backup-create"
  | "backup-schedule"
  | "backup-browse"
  | "backup-note-restore"
  | "backup-download"
  | "backup-delete"
  | "backup-restore"
  | "backup-refresh"
  | "publish-refresh"
  | "publish-delete"
  | "publish-update"
  | "settings-local"
  | "settings-cloud"
  | null;

/**
 * Actions whose controls live in This vault report their failures there. The
 * page banner sits above the account and plan, a long scroll on a phone from
 * the button that was pressed, so a failure there looked like nothing at all.
 */
const VAULT_SECTION_ACTIONS: ReadonlySet<CloudAction> = new Set<CloudAction>([
  "link",
  "unlink",
  "vault-delete",
  "settings-local",
  "settings-cloud",
]);

export function CloudSettings({
  localVaultAvailable,
  localVaultName,
}: {
  localVaultAvailable: boolean;
  localVaultName: string;
}): JSX.Element {
  const [bridge] = useState(() => getZenBridge());
  const localNotes = useStore((state) => state.notes);
  const [status, setStatus] = useState<CloudAccountStatus | null>(null);
  const [serviceAccount, setServiceAccount] =
    useState<CloudServiceAccount | null>(null);
  const [cloudVaults, setCloudVaults] = useState<CloudSyncVault[]>([]);
  const [link, setLink] = useState<CloudVaultLink | null>(null);
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [newVaultName, setNewVaultName] = useState(localVaultName);
  const [summary, setSummary] = useState<CloudSyncRunSummary | null>(null);
  // The settings question is the runtime's, not this panel's: sync raises it
  // and the prompt answers it from anywhere, so this panel only shows it.
  const settingsConflict = useCloudSyncStatusStore((state) => state.settingsConflict);
  const [backups, setBackups] = useState<CloudBackupSnapshot[]>([]);
  const [backupSchedule, setBackupSchedule] =
    useState<CloudBackupSchedule | null>(null);
  const backupNotes = useBackupNotes(bridge);
  const closeBackupNotes = backupNotes.close;
  const [publishedNotes, setPublishedNotes] = useState<CloudPublishedNote[]>(
    [],
  );
  const [backupLabel, setBackupLabel] = useState("");
  const [restoreResult, setRestoreResult] =
    useState<CloudBackupRestoreResult | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [loadingPublishedNotes, setLoadingPublishedNotes] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [action, setAction] = useState<CloudAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<CloudVaultLink | null>(
    null,
  );
  // The list is the truth about what can be opened: a choice that is no
  // longer in it falls back to the first vault that is.
  const effectiveSelectedVaultId = cloudVaults.some(
    (vault) => vault.id === selectedVaultId,
  )
    ? selectedVaultId
    : (cloudVaults[0]?.id ?? "");

  // Only the newest load may write: a sign-in can start a second load while
  // the first is still waiting, and the first must not land on top of it.
  const loadGeneration = useRef(0);

  /**
   * Read the account's vaults from Cloud again. Editing the old list here kept
   * a vault deleted on another device on offer, and opening it failed.
   * `goneId` names a vault this device knows is gone, so a failed read still
   * stops offering that one.
   */
  const refreshCloudVaults = useCallback(
    async (goneId?: string): Promise<void> => {
      const generation = loadGeneration.current;
      try {
        const vaults = await bridge.listCloudVaults();
        if (generation === loadGeneration.current) setCloudVaults(vaults);
      } catch {
        if (generation !== loadGeneration.current || !goneId) return;
        setCloudVaults((current) =>
          current.filter((vault) => vault.id !== goneId),
        );
      }
    },
    [bridge],
  );

  // The link as last drawn, for a store change that arrives between renders:
  // deleting here drops the link from state just before it reports the
  // deletion, and the vault that went is still the drawn one.
  const drawnLink = useRef(link);
  useEffect(() => {
    drawnLink.current = link;
  }, [link]);

  useEffect(() => {
    // One subscription for the panel's whole life. One that was replaced
    // whenever the link changed abandoned the deletion it was answering: the
    // delete re-renders the panel before the host confirms the link is gone.
    let mounted = true;
    const unsubscribe = useCloudSyncStatusStore.subscribe((next, previous) => {
      // A saved decision updates this panel immediately, then the remaining
      // vault sync may finish later. Adopt that result (or a vault reset), but
      // keep explicit restore/manual summaries through unrelated status changes.
      if (next.lastSummary !== previous.lastSummary) setSummary(next.lastSummary);
      // The link went away with its Cloud vault: a sync found it gone while
      // this panel was open, or this panel deleted it. This vault's notice
      // says why. The panel lets go of what belonged to the link and reads
      // the list again, so the vault that is gone is not offered here.
      if (
        next.removedVault !== null &&
        next.removedVault !== previous.removedVault
      ) {
        const goneId = drawnLink.current?.vault_id;
        void bridge.getCloudVaultLink().then((currentLink) => {
          if (!mounted || currentLink !== null) return;
          setLink(null);
          setSummary(null);
          setBackups([]);
          setBackupSchedule(null);
          closeBackupNotes();
          setRestoreResult(null);
          void refreshCloudVaults(goneId);
        }).catch(() => {});
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [bridge, closeBackupNotes, refreshCloudVaults]);

  const loadStatus = useCallback(
    async (nextStatus?: CloudAccountStatus): Promise<void> => {
      const generation = ++loadGeneration.current;
      const superseded = (): boolean => generation !== loadGeneration.current;
      let statusHint = nextStatus;
      for (let attempt = 0; ; attempt += 1) {
        const next = statusHint ?? (await bridge.getCloudAccountStatus());
        if (superseded()) return;
        setStatus(next);
        setError(null);
        setVaultError(null);

        if (next.state !== "connected") {
          setServiceAccount(null);
          setCloudVaults([]);
          setLink(null);
          setSummary(null);
          setBackups([]);
          setBackupSchedule(null);
          closeBackupNotes();
          setPublishedNotes([]);
          setRestoreResult(null);
          return;
        }

        setLoadingDetails(true);
        try {
          const account = await bridge.getCloudServiceAccount();
          if (superseded()) return;
          setServiceAccount(account);

          if (!account.features.sync.active || !localVaultAvailable) {
            setCloudVaults([]);
            setLink(null);
            return;
          }

          const [availableVaults, currentLink] = await Promise.all([
            bridge.listCloudVaults(),
            bridge.getCloudVaultLink(),
          ]);
          if (superseded()) return;
          setCloudVaults(availableVaults);
          setLink(currentLink);
          setSelectedVaultId((current) =>
            availableVaults.some((vault) => vault.id === current)
              ? current
              : (availableVaults[0]?.id ?? ""),
          );
          return;
        } catch (cause) {
          if (superseded()) return;
          // Signing in or out cancels every request in flight while the
          // credential is swapped (the phones do this on purpose). That is not
          // a failure to show: read the account again once the new one is in.
          if (isCancelledRequest(cause) && attempt < CANCELLED_LOAD_RETRIES) {
            statusHint = undefined;
            await new Promise((resolve) => setTimeout(resolve, CANCELLED_LOAD_RETRY_MS));
            if (superseded()) return;
            continue;
          }
          setError(errorMessage(cause, "Could not load ZenNotes Cloud."));
          return;
        } finally {
          if (!superseded()) setLoadingDetails(false);
        }
      }
    },
    [bridge, closeBackupNotes, localVaultAvailable],
  );

  useEffect(() => {
    const refresh = (): void => {
      void loadStatus().catch((cause) => {
        setError(errorMessage(cause, "Could not load ZenNotes Cloud."));
      });
    };

    refresh();
    const unsubscribe = bridge.onCloudAccountChange((next) => {
      void loadStatus(next);
    });
    window.addEventListener("online", refresh);

    return () => {
      unsubscribe();
      window.removeEventListener("online", refresh);
    };
  }, [bridge, loadStatus]);

  const refreshServiceAccount = useCallback(async (): Promise<void> => {
    try {
      setServiceAccount(await bridge.getCloudServiceAccount());
    } catch {
      // Usage is supplementary; the next account refresh will retry it.
    }
  }, [bridge]);

  const backupIncluded = serviceAccount?.features.backup.active === true;
  const publishIncluded = serviceAccount?.features.publish.active === true;
  const connectedBaseUrl =
    status?.state === "connected" ? (status.account?.base_url ?? null) : null;
  const linkMismatch =
    link !== null &&
    connectedBaseUrl !== null &&
    link.base_url !== connectedBaseUrl;
  const activeLink = linkMismatch ? null : link;

  const loadPublishedNotes = useCallback(async (): Promise<void> => {
    if (!publishIncluded) {
      setPublishedNotes([]);
      return;
    }

    setLoadingPublishedNotes(true);
    try {
      setPublishedNotes(await bridge.listCloudPublishedNotes());
      await refreshServiceAccount();
    } catch (cause) {
      if (isCancelledRequest(cause)) return;
      setError(errorMessage(cause, "Could not load published notes."));
    } finally {
      setLoadingPublishedNotes(false);
    }
  }, [bridge, publishIncluded, refreshServiceAccount]);

  useEffect(() => {
    void loadPublishedNotes();
  }, [loadPublishedNotes]);

  const loadBackups = useCallback(async (): Promise<void> => {
    if (!backupIncluded || !activeLink) {
      setBackups([]);
      setBackupSchedule(null);
      closeBackupNotes();
      return;
    }

    setLoadingBackups(true);
    try {
      const [nextBackups, nextSchedule] = await Promise.all([
        bridge.listCloudBackups(),
        bridge.getCloudBackupSchedule(),
      ]);
      setBackups(nextBackups);
      setBackupSchedule(nextSchedule);
      await refreshServiceAccount();
    } catch (cause) {
      if (isCancelledRequest(cause)) return;
      setError(errorMessage(cause, "Could not load cloud backups."));
    } finally {
      setLoadingBackups(false);
    }
  }, [
    activeLink,
    backupIncluded,
    bridge,
    closeBackupNotes,
    refreshServiceAccount,
  ]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  useEffect(() => {
    if (
      !backups.some(
        (backup) => backup.status === "pending" || backup.status === "building",
      )
    ) {
      return;
    }
    const timeout = window.setTimeout(() => void loadBackups(), 3_000);
    return () => window.clearTimeout(timeout);
  }, [backups, loadBackups]);

  const runAction = async (
    nextAction: Exclude<CloudAction, null>,
    operation: () => Promise<void>,
  ): Promise<void> => {
    setAction(nextAction);
    setError(null);
    setVaultError(null);
    try {
      await operation();
    } catch (cause) {
      // Sync errors already live in the shared status store. Duplicating one
      // here leaves it visible after a successful editor/background retry.
      if (nextAction !== "sync") {
        const message = errorMessage(
          cause,
          "ZenNotes Cloud could not complete that action.",
        );
        if (VAULT_SECTION_ACTIONS.has(nextAction)) setVaultError(message);
        else setError(message);
      }
    } finally {
      setAction(null);
    }
  };

  const connect = (): Promise<void> =>
    runAction("connect", async () => {
      await bridge.connectCloudAccount();
      await loadStatus();
    });

  const logout = (): Promise<void> =>
    runAction("logout", async () => {
      await loadStatus(await bridge.logoutCloudAccount());
    });

  const linkSelectedVault = (): Promise<void> =>
    runAction("link", async () => {
      const chosenId = effectiveSelectedVaultId;
      if (!chosenId) return;
      const chosen = cloudVaults.find((vault) => vault.id === chosenId);
      let linked: CloudVaultLink;
      try {
        linked = await bridge.linkCloudVault(chosenId);
      } catch (cause) {
        if (cloudVaultGoneReason(cause) === null) throw cause;
        // The list this choice came from is older than whatever took the
        // vault away. Read it again first, so the answer arrives beside a
        // list that no longer offers it.
        await refreshCloudVaults(chosenId);
        throw new Error(vaultGoneFromListMessage(chosen?.name ?? null));
      }
      setLink(linked);
      setSummary(null);
      clearRemovedCloudVault();
      requestCloudAutoSync("vault-link");
      await refreshCloudVaults();
    });

  const createAndLinkVault = (): Promise<void> =>
    runAction("link", async () => {
      const name = newVaultName.trim();
      if (!name) throw new Error("Enter a name for the cloud vault.");
      const createdLink = await bridge.createAndLinkCloudVault(name);
      setLink(createdLink);
      setSelectedVaultId(createdLink.vault_id);
      setSummary(null);
      clearRemovedCloudVault();
      requestCloudAutoSync("vault-link");
      await refreshCloudVaults();
    });

  const clearLinkedVaultState = (): void => {
    setLink(null);
    setSummary(null);
    setBackups([]);
    setBackupSchedule(null);
    closeBackupNotes();
    setRestoreResult(null);
  };

  const unlinkVault = async (): Promise<void> => {
    const confirmed = await confirmApp({
      title: "Unlink this device?",
      description:
        "Automatic sync stops on this device. The Cloud vault and its backups remain available to your other devices.",
      confirmLabel: "Unlink this device",
      danger: false,
    });
    if (!confirmed) return;

    await runAction("unlink", async () => {
      await bridge.unlinkCloudVault();
      clearLinkedVaultState();
    });
  };

  const deleteVault = (): void => {
    if (link) setDeleteRequest(link);
  };

  const confirmDeleteVault = async (
    deletedVault: CloudVaultLink,
  ): Promise<void> => {
    setDeleteRequest(null);
    await runAction("vault-delete", async () => {
      await bridge.deleteCloudVault();
      clearLinkedVaultState();
      // The status row and This vault keep saying why sync stopped, and the
      // store change is also what reads the vault list again here.
      markCloudVaultDeleted(deletedVault.vault_name);
      await refreshServiceAccount();
      useToastStore
        .getState()
        .addToast(
          `“${deletedVault.vault_name}” was deleted from ZenNotes Cloud.`,
          "success",
        );
    });
  };

  // Opening Settings is a chance the runtime did not have: a question parked
  // before this window existed (or while sync was off) shows up here too.
  useEffect(() => {
    void refreshCloudSettingsConflict(bridge);
  }, [bridge]);

  const syncVault = (): Promise<void> => {
    setSummary(null);
    return runAction("sync", async () => {
      setSummary(await syncCloudVaultWithStatus(bridge, link?.vault_name));
      await refreshCloudSettingsConflict(bridge);
      await refreshServiceAccount();
    });
  };

  const resolveSettingsConflict = (
    choice: CloudSyncSettingsChoice,
  ): Promise<void> =>
    runAction(choice === "cloud" ? "settings-cloud" : "settings-local", () =>
      resolveCloudSettingsConflictWithStatus(choice, bridge),
    );

  const createBackup = (): Promise<void> =>
    runAction("backup-create", async () => {
      const label = backupLabel.trim() || undefined;
      const created = await bridge.createCloudBackup(label);
      setBackups((current) => [
        created,
        ...current.filter((backup) => backup.id !== created.id),
      ]);
      setBackupLabel("");
      setRestoreResult(null);
      await refreshServiceAccount();
    });

  const refreshBackups = (): Promise<void> =>
    runAction("backup-refresh", loadBackups);

  const updateBackupSchedule = (enabled: boolean): Promise<void> =>
    runAction("backup-schedule", async () => {
      setBackupSchedule(await bridge.updateCloudBackupSchedule(enabled));
    });

  const browseBackup = (backup: CloudBackupSnapshot): Promise<void> => {
    if (backupNotes.view?.backupId === backup.id) {
      closeBackupNotes();
      return Promise.resolve();
    }

    return runAction("backup-browse", () => backupNotes.open(backup.id));
  };

  const refreshPublishedNotes = (): Promise<void> =>
    runAction("publish-refresh", loadPublishedNotes);

  const updatePublishedNote = (note: CloudPublishedNote): Promise<void> =>
    runAction("publish-update", async () => {
      if (!note.note_path || !localVaultAvailable) return;
      const store = useStore.getState();
      const diskOrBuffer = store.noteDirty[note.note_path] && store.noteContents[note.note_path]
        ? store.noteContents[note.note_path]
        : await bridge.readNote(note.note_path);
      const current = useStore.getState();
      const local = current.noteDirty[note.note_path] && current.noteContents[note.note_path]
        ? current.noteContents[note.note_path]
        : diskOrBuffer;
      store.setSettingsOpen(false);
      requestPublishNote(local);
    });

  const copyPublishedLink = (note: CloudPublishedNote): void => {
    bridge.clipboardWriteText(note.url);
    useToastStore.getState().addToast("Public link copied.", "success");
  };

  const unpublishNote = async (note: CloudPublishedNote): Promise<void> => {
    const confirmed = await confirmApp({
      title: `Unpublish ${note.title}?`,
      description:
        "The public link will stop working. Your local and synced note are not changed.",
      confirmLabel: "Unpublish",
      danger: true,
    });
    if (!confirmed) return;

    await runAction("publish-delete", async () => {
      await bridge.unpublishCloudNote(note.id);
      setPublishedNotes((current) =>
        current.filter((candidate) => candidate.id !== note.id),
      );
      if (note.note_path) {
        notifyPublishedNoteChanged({ notePath: note.note_path, url: null });
      }
      await refreshServiceAccount();
    });
  };

  const deleteBackup = async (backup: CloudBackupSnapshot): Promise<void> => {
    const confirmed = await confirmApp({
      title: "Delete this cloud backup?",
      description:
        "This removes the recovery archive permanently. Your synced vault is not changed.",
      confirmLabel: "Delete backup",
      danger: true,
    });
    if (!confirmed) return;

    await runAction("backup-delete", async () => {
      await bridge.deleteCloudBackup(backup.id);
      setBackups((current) =>
        current.filter((candidate) => candidate.id !== backup.id),
      );
      setRestoreResult(null);
      await refreshServiceAccount();
    });
  };

  const downloadBackup = (backup: CloudBackupSnapshot): Promise<void> =>
    runAction("backup-download", async () => {
      await bridge.downloadCloudBackup(backup.id);
    });

  const restoreBackup = async (backup: CloudBackupSnapshot): Promise<void> => {
    const confirmed = await confirmApp({
      title: `Restore ${backup.label || "this backup"}?`,
      description:
        "ZenNotes will replace the linked cloud vault with this snapshot, then sync the restored contents to this device. Changes made after the backup may be removed.",
      confirmLabel: "Restore backup",
      danger: true,
    });
    if (!confirmed) return;

    await runAction("backup-restore", async () => {
      const result = await bridge.restoreCloudBackup(backup.id);
      setRestoreResult(result);
      if (result.sync) setSummary(result.sync);
      await loadBackups();
    });
  };

  const restoreBackupNote = async (
    backup: CloudBackupSnapshot,
    item: CloudBackupSnapshotItem,
  ): Promise<void> => {
    const confirmed = await confirmApp({
      title: `Restore ${item.path}?`,
      description:
        "This creates a new synced version of this note from the selected backup. Other notes are unchanged.",
      confirmLabel: "Restore note",
      danger: false,
    });
    if (!confirmed) return;

    await runAction("backup-note-restore", async () => {
      const result: CloudBackupNoteRestoreResult =
        await bridge.restoreCloudBackupNote(backup.id, item.id);
      setSummary(result.sync);
      useToastStore.getState().addToast(`${item.path} restored.`, "success");
      await loadBackups();
    });
  };

  if (status === null) {
    return <CloudLoadingState />;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm leading-6 text-danger"
        >
          {error}
        </div>
      )}

      {status.state === "disconnected" && (
        <CloudDisconnected
          busy={action === "connect"}
          onConnect={() => void connect()}
        />
      )}

      {status.state === "connecting" && (
        <CloudConnecting
          busy={action === "logout"}
          onCancel={() => void logout()}
        />
      )}

      {status.state === "connected" && status.account && (
        <>
          <section
            data-settings-search-id="cloud-account"
            className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45"
          >
            <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink-900">
                  {status.account.user.name}
                </div>
                <div className="mt-1 truncate text-xs text-ink-500">
                  {status.account.user.email}
                </div>
                <div className="mt-1 truncate text-xs text-ink-400">
                  {status.account.device.name} · {status.account.base_url}
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={action !== null}
                onClick={() => void logout()}
              >
                {action === "logout" ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </section>

          {loadingDetails && !serviceAccount ? (
            <CloudLoadingState compact />
          ) : serviceAccount ? (
            <>
              <CloudFeatureList account={serviceAccount} />
              <CloudUsageSummary account={serviceAccount} />
              <CloudVaultPanel
                action={action}
                cloudVaults={cloudVaults}
                currentBaseUrl={status.account.base_url}
                link={link}
                linkMismatch={linkMismatch}
                localVaultAvailable={localVaultAvailable}
                newVaultName={newVaultName}
                selectedVaultId={effectiveSelectedVaultId}
                summary={summary}
                vaultError={vaultError}
                onSummaryChange={setSummary}
                onCreateAndLink={() => void createAndLinkVault()}
                onLink={() => void linkSelectedVault()}
                onNewVaultNameChange={setNewVaultName}
                onSelectedVaultChange={setSelectedVaultId}
                onSync={() => void syncVault()}
                onUnlink={() => void unlinkVault()}
                onDelete={deleteVault}
                onDismissRemoval={clearRemovedCloudVault}
                onUseAnotherAccount={() => void logout()}
                settingsConflict={settingsConflict}
                onResolveSettingsConflict={(choice) =>
                  void resolveSettingsConflict(choice)
                }
                syncIncluded={serviceAccount.features.sync.active}
              />
              <CloudPublishedNotesPanel
                action={action}
                loading={loadingPublishedNotes}
                notes={publishedNotes}
                publishedBytes={serviceAccount.usage?.storage.publish_bytes}
                publishIncluded={publishIncluded}
                usage={serviceAccount.usage?.publish}
                onCopy={copyPublishedLink}
                onOpen={(note) => window.open(note.url, "_blank")}
                onRefresh={() => void refreshPublishedNotes()}
                onUnpublish={(note) => void unpublishNote(note)}
                onUpdate={(note) => void updatePublishedNote(note)}
                canUpdate={(note) => localVaultAvailable && localNotes.some((local) => local.path === note.note_path)}
              />
              <CloudBackupPanel
                action={action}
                backupIncluded={backupIncluded}
                backupLabel={backupLabel}
                backupNotes={backupNotes}
                backups={backups}
                limits={serviceAccount.features.backup.limits}
                link={activeLink}
                loading={loadingBackups}
                restoreResult={restoreResult}
                schedule={backupSchedule}
                onBackupLabelChange={setBackupLabel}
                onCreate={() => void createBackup()}
                onBrowse={(backup) => void browseBackup(backup)}
                onDelete={(backup) => void deleteBackup(backup)}
                onDownload={(backup) => void downloadBackup(backup)}
                onRefresh={() => void refreshBackups()}
                onRestore={(backup) => void restoreBackup(backup)}
                onRestoreNote={(backup, item) =>
                  void restoreBackupNote(backup, item)
                }
                onScheduleChange={(enabled) =>
                  void updateBackupSchedule(enabled)
                }
              />
            </>
          ) : null}
        </>
      )}

      {deleteRequest && (
        <CloudVaultDeleteDialog
          vaultName={deleteRequest.vault_name}
          onConfirm={() => void confirmDeleteVault(deleteRequest)}
          onCancel={() => setDeleteRequest(null)}
        />
      )}
    </div>
  );
}

function CloudPublishedNotesPanel({
  action,
  loading,
  notes,
  publishedBytes,
  publishIncluded,
  usage,
  onCopy,
  onOpen,
  onRefresh,
  onUnpublish,
  onUpdate,
  canUpdate,
}: {
  action: CloudAction;
  loading: boolean;
  notes: CloudPublishedNote[];
  publishedBytes?: number;
  publishIncluded: boolean;
  usage?: CloudUsage["publish"];
  onCopy: (note: CloudPublishedNote) => void;
  onOpen: (note: CloudPublishedNote) => void;
  onRefresh: () => void;
  onUnpublish: (note: CloudPublishedNote) => void;
  onUpdate: (note: CloudPublishedNote) => void;
  canUpdate: (note: CloudPublishedNote) => boolean;
}): JSX.Element {
  if (!publishIncluded) {
    return (
      <CloudNotice>
        Publishing is not included in this subscription.
      </CloudNotice>
    );
  }

  return (
    <section
      data-settings-search-id="cloud-published-notes"
      aria-labelledby="cloud-published-notes-heading"
      className="space-y-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3
            id="cloud-published-notes-heading"
            className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
          >
            Published notes
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            {usage
              ? `${pluralize(usage.notes, "published note")} · ${pluralize(usage.assets, "asset")} using ${formatBytes(publishedBytes ?? 0)}.`
              : "Anyone with a link can view a published note until you unpublish it."}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-500">
            Edits stay private until you choose Update note. Refresh list checks published status.
          </p>
        </div>
        <Button
          variant="ghost"
          disabled={action !== null || loading}
          onClick={onRefresh}
        >
          {action === "publish-refresh" || loading ? "Refreshing…" : "Refresh list"}
        </Button>
      </div>

      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        {notes.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            {loading ? "Loading published notes…" : "No published notes yet."}
          </div>
        ) : (
          <div className="divide-y divide-paper-300/45">
            {notes.map((note) => (
              <div
                key={note.id}
                className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink-900">
                    {note.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    {note.note_path && (
                      <span className="truncate">{note.note_path}</span>
                    )}
                    {note.updated_at && (
                      <span>
                        Updated {formatCloudVaultDate(note.updated_at)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    disabled={action !== null || !canUpdate(note)}
                    title={canUpdate(note) ? "Review and publish the latest content from this vault" : "Open the vault containing this note to update it"}
                    onClick={() => onUpdate(note)}
                  >
                    Update note
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => onCopy(note)}
                  >
                    Copy link
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => onOpen(note)}
                  >
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => onUnpublish(note)}
                  >
                    {action === "publish-delete"
                      ? "Unpublishing…"
                      : "Unpublish"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CloudDisconnected({
  busy,
  onConnect,
}: {
  busy: boolean;
  onConnect: () => void;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
      <div className="flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <h3 className="text-base font-semibold text-ink-900">
            Keep your vault available everywhere
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            Connect your ZenNotes account to sync this vault, create recoverable
            backups, and publish notes included in your plan.
          </p>
        </div>
        <Button variant="primary" size="md" disabled={busy} onClick={onConnect}>
          {busy ? "Opening browser…" : "Connect ZenNotes Cloud"}
        </Button>
      </div>
    </section>
  );
}

function CloudConnecting({
  busy,
  onCancel,
}: {
  busy: boolean;
  onCancel: () => void;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-3xl border border-accent/25 bg-accent/5">
      <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Finish signing in in your browser
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            Return to ZenNotes after approving this device. The request expires
            after five minutes.
          </p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {busy ? "Cancelling…" : "Cancel sign-in"}
        </Button>
      </div>
    </section>
  );
}

function CloudFeatureList({
  account,
}: {
  account: CloudServiceAccount;
}): JSX.Element {
  const features = [
    ["Sync", account.features.sync.active],
    ["Backup", account.features.backup.active],
    ["Publish", account.features.publish.active],
  ] as const;

  return (
    <section
      data-settings-search-id="cloud-plan"
      aria-labelledby="cloud-plan-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-plan-heading"
          className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          Current plan
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          Access is checked by the service on every request, independent of this
          device.
        </p>
      </div>
      <div className="grid gap-px overflow-hidden rounded-2xl border border-paper-300/60 bg-paper-300/60 sm:grid-cols-3">
        {features.map(([label, active]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 bg-paper-50 px-4 py-3"
          >
            <span className="text-sm font-medium text-ink-800">{label}</span>
            <span
              className={
                active
                  ? "text-xs font-medium text-accent"
                  : "text-xs text-ink-400"
              }
            >
              {active ? "Included" : "Not included"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CloudUsageSummary({
  account,
}: {
  account: CloudServiceAccount;
}): JSX.Element | null {
  const usage = account.usage;
  if (!usage) return null;

  const syncLimit = numericLimit(
    account.features.sync.limits,
    "max_storage_bytes",
  );
  const retentionDays = numericLimit(
    account.features.backup.limits,
    "retention_days",
  );
  const syncPercent =
    syncLimit && syncLimit > 0
      ? Math.min(100, (usage.storage.sync_bytes / syncLimit) * 100)
      : null;

  return (
    <section
      data-settings-search-id="cloud-usage"
      aria-labelledby="cloud-usage-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-usage-heading"
          className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          Cloud storage
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          {formatBytes(usage.storage.total_bytes)} stored across synced vault
          files, backup archives, and published content.
        </p>
      </div>

      <div className="grid gap-px overflow-hidden rounded-2xl border border-paper-300/60 bg-paper-300/60 sm:grid-cols-3">
        <CloudUsageCard
          label="Synced files"
          value={
            syncLimit
              ? `${formatBytes(usage.storage.sync_bytes)} of ${formatBytes(syncLimit)}`
              : formatBytes(usage.storage.sync_bytes)
          }
          detail={`${pluralize(usage.sync.items, "synced file")} across ${pluralize(usage.sync.vaults, "vault")}`}
          secondaryDetail={`${usage.sync.markdown_items ?? 0} Markdown · ${usage.sync.binary_items ?? 0} binary · ${usage.sync.other_items ?? 0} other · ${usage.sync.metadata_items ?? 0} ZenNotes metadata`}
          percent={syncPercent}
        />
        <CloudUsageCard
          label="Backups"
          value={formatBytes(usage.storage.backup_bytes)}
          detail={`${pluralize(usage.backup.snapshots, "backup")}${retentionDays ? ` · ${retentionDays}-day retention` : ""}`}
        />
        <CloudUsageCard
          label="Publishing"
          value={formatBytes(usage.storage.publish_bytes)}
          detail={pluralize(usage.publish.notes, "published note")}
        />
      </div>
    </section>
  );
}

function CloudUsageCard({
  detail,
  label,
  percent,
  secondaryDetail,
  value,
}: {
  detail: string;
  label: string;
  percent?: number | null;
  secondaryDetail?: string;
  value: string;
}): JSX.Element {
  return (
    <div className="bg-paper-50 px-4 py-4">
      <div className="text-xs font-medium text-ink-500">{label}</div>
      <div className="mt-1 text-base font-semibold text-ink-900">{value}</div>
      {percent !== null && percent !== undefined && (
        <div
          role="progressbar"
          aria-label={`${label} storage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="mt-3 h-1 overflow-hidden rounded-full bg-paper-300/65"
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.max(percent, 0.5)}%` }}
          />
        </div>
      )}
      <div className="mt-2 text-xs leading-5 text-ink-500">{detail}</div>
      {secondaryDetail && (
        <div className="mt-1 text-xs leading-5 text-ink-400">
          {secondaryDetail}
        </div>
      )}
    </div>
  );
}

function CloudVaultPanel({
  action,
  cloudVaults,
  currentBaseUrl,
  link,
  linkMismatch,
  localVaultAvailable,
  newVaultName,
  selectedVaultId,
  settingsConflict,
  summary,
  syncIncluded,
  vaultError,
  onCreateAndLink,
  onLink,
  onNewVaultNameChange,
  onResolveSettingsConflict,
  onSelectedVaultChange,
  onSync,
  onUnlink,
  onDelete,
  onDismissRemoval,
  onUseAnotherAccount,
  onSummaryChange,
}: {
  action: CloudAction;
  cloudVaults: CloudSyncVault[];
  currentBaseUrl: string;
  link: CloudVaultLink | null;
  linkMismatch: boolean;
  localVaultAvailable: boolean;
  newVaultName: string;
  selectedVaultId: string;
  settingsConflict: CloudSyncSettingsConflict | null;
  summary: CloudSyncRunSummary | null;
  syncIncluded: boolean;
  vaultError: string | null;
  onCreateAndLink: () => void;
  onLink: () => void;
  onNewVaultNameChange: (value: string) => void;
  onResolveSettingsConflict: (choice: CloudSyncSettingsChoice) => void;
  onSelectedVaultChange: (value: string) => void;
  onSync: () => void;
  onUnlink: () => void;
  onDelete: () => void;
  onDismissRemoval: () => void;
  onUseAnotherAccount: () => void;
  onSummaryChange: (summary: CloudSyncRunSummary) => void;
}): JSX.Element {
  const lastSummary = useCloudSyncStatusStore((s) => s.lastSummary);
  const syncPhase = useCloudSyncStatusStore((s) => s.phase);
  const syncError = useCloudSyncStatusStore((s) => s.error);
  const removedVault = useCloudSyncStatusStore((s) => s.removedVault);
  const syncing = syncPhase === "syncing" || action === "sync";
  const syncFailed = syncPhase === "error";
  const currentResult = !syncing && !syncFailed;
  const displayedSummary = summary ?? lastSummary;
  if (!syncIncluded) {
    return (
      <CloudNotice>Sync is not included in this subscription.</CloudNotice>
    );
  }
  if (!localVaultAvailable) {
    return (
      <CloudNotice>
        Save this folder as a local vault before linking it to ZenNotes Cloud.
      </CloudNotice>
    );
  }

  return (
    <section
      data-settings-search-id="cloud-vault"
      aria-labelledby="cloud-vault-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-vault-heading"
          className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          This vault
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          A local vault links to one cloud vault. Nothing syncs until you choose
          a destination.
        </p>
      </div>

      {vaultError && <CloudSectionError message={vaultError} />}
      {!link && removedVault && (
        <CloudVaultRemovedNotice
          removal={removedVault}
          vaultsToChoose={cloudVaults.length > 0}
          onDismiss={onDismissRemoval}
        />
      )}

      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        {link && linkMismatch ? (
          <div className="divide-y divide-paper-300/45">
            <div role="status" className="space-y-4 bg-accent/5 px-5 py-5">
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-ink-900">
                  Move this vault to the current account
                </h4>
                <p className="text-sm leading-6 text-ink-600">
                  This vault was linked to{" "}
                  <span className="break-all font-mono text-xs text-ink-800">
                    {link.base_url}
                  </span>
                  . You’re now connected to{" "}
                  <span className="break-all font-mono text-xs text-ink-800">
                    {currentBaseUrl}
                  </span>
                  .
                </p>
                <p className="text-sm leading-6 text-ink-500">
                  Your local notes stay on this device. The old link is replaced
                  only after the new cloud vault is ready.
                </p>
              </div>
              <Button
                variant="ghost"
                disabled={action !== null}
                onClick={onUseAnotherAccount}
              >
                {action === "logout" ? "Disconnecting…" : "Use another account"}
              </Button>
            </div>
            <CloudVaultDestinationOptions
              action={action}
              cloudVaults={cloudVaults}
              moving
              newVaultName={newVaultName}
              selectedVaultId={selectedVaultId}
              onCreateAndLink={onCreateAndLink}
              onLink={onLink}
              onNewVaultNameChange={onNewVaultNameChange}
              onSelectedVaultChange={onSelectedVaultChange}
            />
          </div>
        ) : link ? (
          <div className="space-y-4 px-5 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  Linked to {link.vault_name}
                </div>
                <div className="mt-1 text-xs text-ink-500">
                  Syncs automatically on this device.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  disabled={action !== null}
                  onClick={onUnlink}
                >
                  {action === "unlink" ? "Unlinking…" : "Unlink this device"}
                </Button>
                <Button
                  variant="danger"
                  disabled={action !== null}
                  onClick={onDelete}
                >
                  {action === "vault-delete"
                    ? "Deleting…"
                    : "Delete Cloud vault"}
                </Button>
                <Button
                  variant="primary"
                  disabled={action !== null || syncing}
                  onClick={onSync}
                >
                  {syncing ? "Syncing…" : "Sync now"}
                </Button>
              </div>
            </div>
            {settingsConflict && (
              <CloudSettingsConflictCard
                action={action}
                conflict={settingsConflict}
                onResolve={onResolveSettingsConflict}
                onCompare={openCloudSettingsConflictPrompt}
              />
            )}
            {syncing && (
              <div role="status" className="text-sm text-ink-500">
                Syncing… Waiting for all changes to finish.
              </div>
            )}
            {syncFailed && !syncing && (
              <div role="alert" className="text-sm text-danger">
                {syncError ?? "Sync failed. Please try again."}
              </div>
            )}
            {displayedSummary &&
              (currentResult || cloudSyncAttentionMessage(displayedSummary)) && (
                <CloudSyncSummary
                  summary={displayedSummary}
                  showStatus={currentResult}
                  vaultName={link.vault_name}
                  onSummaryChange={onSummaryChange}
                />
              )}
          </div>
        ) : (
          <CloudVaultDestinationOptions
            action={action}
            cloudVaults={cloudVaults}
            moving={false}
            newVaultName={newVaultName}
            selectedVaultId={selectedVaultId}
            onCreateAndLink={onCreateAndLink}
            onLink={onLink}
            onNewVaultNameChange={onNewVaultNameChange}
            onSelectedVaultChange={onSelectedVaultChange}
          />
        )}
      </div>
    </section>
  );
}

function CloudVaultDestinationOptions({
  action,
  cloudVaults,
  moving,
  newVaultName,
  selectedVaultId,
  onCreateAndLink,
  onLink,
  onNewVaultNameChange,
  onSelectedVaultChange,
}: {
  action: CloudAction;
  cloudVaults: CloudSyncVault[];
  moving: boolean;
  newVaultName: string;
  selectedVaultId: string;
  onCreateAndLink: () => void;
  onLink: () => void;
  onNewVaultNameChange: (value: string) => void;
  onSelectedVaultChange: (value: string) => void;
}): JSX.Element {
  const selectedVault =
    cloudVaults.find((vault) => vault.id === selectedVaultId) ??
    cloudVaults[0] ??
    null;

  return (
    <div className="divide-y divide-paper-300/45">
      {cloudVaults.length > 0 && (
        <div className="space-y-4 px-5 py-5">
          <div>
            <h4 className="text-sm font-semibold text-ink-900">
              {moving
                ? "Move to an existing cloud vault"
                : "Continue with your cloud vault"}
            </h4>
            <p className="mt-1 text-sm leading-6 text-ink-500">
              {moving
                ? "Choose where this device should sync next."
                : "Open the same notes you use on your other devices."}
            </p>
          </div>

          {cloudVaults.length > 1 && (
            <select
              id="cloud-vault-select"
              aria-label="Cloud vault"
              value={selectedVaultId}
              disabled={action !== null}
              onChange={(event) => onSelectedVaultChange(event.target.value)}
              className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent disabled:opacity-50"
            >
              {cloudVaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}
                </option>
              ))}
            </select>
          )}

          <div className="flex flex-col gap-4 rounded-2xl border border-paper-300/60 bg-paper-100/45 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink-900">
                {selectedVault?.name}
              </div>
              {selectedVault && (
                <div className="mt-1 text-xs text-ink-500">
                  Updated {formatCloudVaultDate(selectedVault.updated_at)}
                </div>
              )}
            </div>
            <Button
              variant="primary"
              disabled={!selectedVaultId || action !== null}
              onClick={onLink}
            >
              {action === "link"
                ? moving
                  ? "Moving…"
                  : "Opening…"
                : moving
                  ? "Move here"
                  : "Open on this device"}
            </Button>
          </div>

          {!moving && (
            <p className="text-xs leading-5 text-ink-500">
              Notes already on this device are merged safely. If the same part
              changed in both places, your local note stays untouched while
              ZenNotes keeps the Cloud comparison safe until you choose.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3 px-5 py-5">
        <label
          htmlFor="new-cloud-vault-name"
          className="text-sm font-medium text-ink-800"
        >
          {cloudVaults.length > 0
            ? "Start a separate cloud vault"
            : "Create a new cloud vault"}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="new-cloud-vault-name"
            value={newVaultName}
            maxLength={120}
            disabled={action !== null}
            onChange={(event) => onNewVaultNameChange(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent disabled:opacity-50"
            placeholder="My notes"
          />
          <Button
            disabled={!newVaultName.trim() || action !== null}
            onClick={onCreateAndLink}
          >
            {action === "link"
              ? "Creating…"
              : moving
                ? "Create and move"
                : "Create and link"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One expanded backup and its notes, as far as they have been loaded. */
interface BackupNotesView {
  backupId: string;
  items: CloudBackupSnapshotItem[];
  /** Null on a host that lists a backup's first page alone and cannot search. */
  paging: Omit<CloudBackupItemsPage, "items"> | null;
  /** Notes in the whole backup, whatever the search. */
  notesTotal: number;
}

interface BackupNotes {
  view: BackupNotesView | null;
  search: string;
  /** The service has not answered the search in the box yet. */
  searching: boolean;
  loadingMore: boolean;
  error: string | null;
  open: (backupId: string) => Promise<void>;
  close: () => void;
  setSearch: (value: string) => void;
  loadMore: () => Promise<void>;
}

const BACKUP_NOTES_SEARCH_DELAY_MS = 250;

/**
 * Browsing one backup's notes. The service lists a backup 50 notes at a time,
 * so a search has to run there: filtering here could only ever find notes on
 * the pages already loaded. Those rows are still filtered as the search is
 * typed, so the list answers at once and the service's answer replaces it.
 */
function useBackupNotes(bridge: ZenBridge): BackupNotes {
  const [view, setView] = useState<BackupNotesView | null>(null);
  const [search, setSearchValue] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest backup opened may land, and not after it was closed. An
  // open that fails leaves the backup already showing as it was.
  const latestOpen = useRef(0);
  // Only the newest answer about the backup on screen may land: one for an
  // older search would show notes for words no longer in the box.
  const latestRequest = useRef(0);
  // What the newest request searched for, so words the list already answers
  // (or is waiting on) are not asked again. A failure forgets them, so the
  // same words can be asked again once the search changes.
  const requestedSearch = useRef<string | null>("");

  const close = useCallback((): void => {
    latestOpen.current += 1;
    latestRequest.current += 1;
    requestedSearch.current = "";
    setView(null);
    setSearchValue("");
    setLoadingMore(false);
    setError(null);
  }, []);

  const open = async (backupId: string): Promise<void> => {
    const opening = ++latestOpen.current;
    let next: BackupNotesView;
    if (bridge.listCloudBackupItemsPage) {
      const { items, ...paging } = await bridge.listCloudBackupItemsPage(
        backupId,
        { page: 1 },
      );
      next = { backupId, items, paging, notesTotal: paging.total };
    } else {
      const items = await bridge.listCloudBackupItems(backupId);
      next = { backupId, items, paging: null, notesTotal: items.length };
    }
    if (opening !== latestOpen.current) return;
    latestRequest.current += 1;
    requestedSearch.current = "";
    setView(next);
    setSearchValue("");
    setLoadingMore(false);
    setError(null);
  };

  const searchNotes = useCallback(
    async (backupId: string, term: string): Promise<void> => {
      if (!bridge.listCloudBackupItemsPage) return;
      const request = ++latestRequest.current;
      requestedSearch.current = term;
      setLoadingMore(false);
      setError(null);
      try {
        const { items, ...paging } = await bridge.listCloudBackupItemsPage(
          backupId,
          { page: 1, search: term },
        );
        if (request !== latestRequest.current) return;
        setView((current) =>
          current?.backupId === backupId
            ? { ...current, items, paging }
            : current,
        );
      } catch (cause) {
        if (request !== latestRequest.current) return;
        requestedSearch.current = null;
        setError(errorMessage(cause, "Could not search this backup."));
      }
    },
    [bridge],
  );

  const backupId = view?.backupId ?? null;
  const searchable = view !== null && view.paging !== null;
  const searchTerm = search.trim();
  useEffect(() => {
    if (backupId === null || !searchable) return;
    if (searchTerm === requestedSearch.current) return;
    const timer = window.setTimeout(() => {
      if (searchTerm !== requestedSearch.current) {
        void searchNotes(backupId, searchTerm);
      }
    }, BACKUP_NOTES_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [backupId, searchable, searchTerm, searchNotes]);

  const loadMore = async (): Promise<void> => {
    if (!view?.paging || view.paging.page >= view.paging.lastPage) return;
    if (!bridge.listCloudBackupItemsPage) return;
    const { backupId: loadingId, paging } = view;
    const request = ++latestRequest.current;
    requestedSearch.current = paging.search;
    setLoadingMore(true);
    setError(null);
    try {
      const { items, ...nextPaging } = await bridge.listCloudBackupItemsPage(
        loadingId,
        { page: paging.page + 1, search: paging.search },
      );
      if (request !== latestRequest.current) return;
      setView((current) => {
        if (current?.backupId !== loadingId) return current;
        // Pages are offsets, so a note can come back twice when the order
        // shifts between two requests. The list keeps each note once.
        const loaded = new Set(current.items.map((item) => item.id));
        return {
          ...current,
          items: [
            ...current.items,
            ...items.filter((item) => !loaded.has(item.id)),
          ],
          paging: nextPaging,
        };
      });
    } catch (cause) {
      if (request !== latestRequest.current) return;
      setError(errorMessage(cause, "Could not load more notes."));
    } finally {
      if (request === latestRequest.current) setLoadingMore(false);
    }
  };

  const setSearch = (value: string): void => {
    setSearchValue(value);
    // Nothing is asked again until the words change, so a failure stays on
    // screen until they do.
    if (value.trim() !== searchTerm) setError(null);
  };

  return {
    view,
    search,
    searching:
      view !== null &&
      view.paging !== null &&
      searchTerm !== view.paging.search &&
      error === null,
    loadingMore,
    error,
    open,
    close,
    setSearch,
    loadMore,
  };
}

function CloudBackupPanel({
  action,
  backupIncluded,
  backupLabel,
  backupNotes,
  backups,
  limits,
  link,
  loading,
  restoreResult,
  schedule,
  onBackupLabelChange,
  onBrowse,
  onCreate,
  onDelete,
  onDownload,
  onRefresh,
  onRestore,
  onRestoreNote,
  onScheduleChange,
}: {
  action: CloudAction;
  backupIncluded: boolean;
  backupLabel: string;
  backupNotes: BackupNotes;
  backups: CloudBackupSnapshot[];
  limits: Record<string, unknown> | null;
  link: CloudVaultLink | null;
  loading: boolean;
  restoreResult: CloudBackupRestoreResult | null;
  schedule: CloudBackupSchedule | null;
  onBackupLabelChange: (value: string) => void;
  onBrowse: (backup: CloudBackupSnapshot) => void;
  onCreate: () => void;
  onDelete: (backup: CloudBackupSnapshot) => void;
  onDownload: (backup: CloudBackupSnapshot) => void;
  onRefresh: () => void;
  onRestore: (backup: CloudBackupSnapshot) => void;
  onRestoreNote: (
    backup: CloudBackupSnapshot,
    item: CloudBackupSnapshotItem,
  ) => void;
  onScheduleChange: (enabled: boolean) => void;
}): JSX.Element {
  const [recoveryDate, setRecoveryDate] = useState("");
  const expandedNotes = backupNotes.view;
  const latestRecoveryDate = localDateKey(new Date().toISOString());
  const recoveryDateIsFuture = recoveryDate > latestRecoveryDate;
  const recoverySelection = recoveryDateIsFuture
    ? {
        backups: [],
        notice: "Choose today or an earlier date.",
      }
    : selectBackupsForDate(backups, recoveryDate);

  if (!backupIncluded) {
    return (
      <CloudNotice>Backups are not included in this subscription.</CloudNotice>
    );
  }
  if (!link) {
    return (
      <CloudNotice>Link this vault before creating cloud backups.</CloudNotice>
    );
  }

  const maxSnapshots = numericLimit(limits, "max_snapshots");
  const maxSnapshotBytes = numericLimit(limits, "max_snapshot_bytes");
  const retentionDays = numericLimit(limits, "retention_days");
  const backupPolicy = [
    maxSnapshots ? `Up to ${maxSnapshots} backups per vault` : null,
    retentionDays ? `kept for ${retentionDays} days` : null,
    maxSnapshotBytes
      ? `${formatBytes(maxSnapshotBytes)} maximum per backup`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      data-settings-search-id="cloud-backups"
      aria-labelledby="cloud-backups-heading"
      className="space-y-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3
            id="cloud-backups-heading"
            className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
          >
            Backups
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            {backupPolicy || "Create a recovery point from the synced vault."}
          </p>
        </div>
        <Button
          variant="ghost"
          disabled={action !== null || loading}
          onClick={onRefresh}
        >
          {action === "backup-refresh" || loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {restoreResult && <CloudRestoreResult result={restoreResult} />}

      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        <div className="flex items-center justify-between gap-4 border-b border-paper-300/45 px-5 py-5">
          <div>
            <div className="text-sm font-medium text-ink-900">
              Automatic daily backups
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              Creates a backup each day when this vault changed.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={schedule?.enabled ?? false}
            aria-label="Automatic daily backups"
            disabled={action !== null || schedule === null}
            onClick={() => onScheduleChange(!(schedule?.enabled ?? false))}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
              schedule?.enabled
                ? "border-accent bg-accent"
                : "border-paper-400 bg-paper-200"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-paper-50 shadow-sm transition-transform ${
                schedule?.enabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="border-b border-paper-300/45 px-5 py-5">
          <div className="mb-3">
            <div className="text-sm font-medium text-ink-900">
              Create a backup now
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              Add a label so this recovery point is easy to find later.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="Backup label"
              value={backupLabel}
              maxLength={120}
              disabled={action !== null}
              onChange={(event) => onBackupLabelChange(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent disabled:opacity-50"
              placeholder="Before a major edit"
            />
            <Button disabled={action !== null} onClick={onCreate}>
              {action === "backup-create" ? "Creating…" : "Create backup"}
            </Button>
          </div>
        </div>

        {backups.length > 0 && (
          <div className="border-b border-paper-300/45 px-5 py-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <label
                  htmlFor="cloud-backup-recovery-date"
                  className="text-sm font-medium text-ink-900"
                >
                  Restore from date
                </label>
                <p className="mt-1 text-xs leading-5 text-ink-500">
                  Choose a recovery date, then restore the vault or browse its
                  notes.
                </p>
              </div>
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <input
                  id="cloud-backup-recovery-date"
                  type="date"
                  aria-label="Restore from date"
                  value={recoveryDate}
                  max={latestRecoveryDate}
                  aria-invalid={recoveryDateIsFuture}
                  onChange={(event) => setRecoveryDate(event.target.value)}
                  className={`min-w-0 flex-1 rounded-lg border bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none sm:w-44 ${
                    recoveryDateIsFuture
                      ? "border-danger/60 focus:border-danger"
                      : "border-paper-300 focus:border-accent"
                  }`}
                />
                {recoveryDate && (
                  <Button variant="ghost" onClick={() => setRecoveryDate("")}>
                    Show all
                  </Button>
                )}
              </div>
            </div>
            {recoverySelection.notice && (
              <p
                role="status"
                className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${
                  recoveryDateIsFuture
                    ? "border-danger/35 bg-danger/10 text-danger"
                    : "border-paper-300/50 bg-paper-100/55 text-ink-600"
                }`}
              >
                {recoverySelection.notice}
              </p>
            )}
          </div>
        )}

        {backups.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            {loading ? "Loading backups…" : "No backups yet."}
          </div>
        ) : recoverySelection.backups.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            Choose another date or show all backups.
          </div>
        ) : (
          <div className="divide-y divide-paper-300/45">
            {recoverySelection.backups.map((backup) => {
              const expanded = expandedNotes?.backupId === backup.id;

              return (
                <div key={backup.id}>
                  <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-900">
                          {backup.label ||
                            `Backup from ${formatBackupDate(backup.created_at)}`}
                        </span>
                        <span className="rounded-full bg-paper-200 px-2 py-0.5 text-[11px] font-medium text-ink-500">
                          {backup.trigger === "automatic"
                            ? "Automatic"
                            : "Manual"}
                        </span>
                        <CloudBackupStatus status={backup.status} />
                      </div>
                      <div className="mt-1 text-xs leading-5 text-ink-500">
                        {backup.item_count} items ·{" "}
                        {formatBytes(backup.total_bytes)} source
                        {backup.archive_bytes !== null && (
                          <> · {formatBytes(backup.archive_bytes)} archive</>
                        )}
                      </div>
                      <div className="text-xs leading-5 text-ink-400">
                        Created {formatBackupDate(backup.created_at)}
                        {backup.expires_at && (
                          <> · Expires {formatBackupDate(backup.expires_at)}</>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        disabled={action !== null || backup.status !== "ready"}
                        onClick={() => onBrowse(backup)}
                      >
                        {action === "backup-browse" && expanded
                          ? "Loading…"
                          : expanded
                            ? "Hide notes"
                            : "Browse notes"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={action !== null || backup.status !== "ready"}
                        onClick={() => onDownload(backup)}
                      >
                        {action === "backup-download"
                          ? "Saving…"
                          : "Save archive"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={action !== null || backup.status !== "ready"}
                        onClick={() => onRestore(backup)}
                      >
                        {action === "backup-restore" ? "Restoring…" : "Restore"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={action !== null}
                        onClick={() => onDelete(backup)}
                      >
                        {action === "backup-delete" ? "Deleting…" : "Delete"}
                      </Button>
                    </div>
                  </div>

                  {expanded && expandedNotes && (
                    <CloudBackupNotes
                      action={action}
                      backup={backup}
                      notes={expandedNotes}
                      search={backupNotes.search}
                      searching={backupNotes.searching}
                      loadingMore={backupNotes.loadingMore}
                      error={backupNotes.error}
                      onSearchChange={backupNotes.setSearch}
                      onLoadMore={backupNotes.loadMore}
                      onRestoreNote={onRestoreNote}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function CloudBackupNotes({
  action,
  backup,
  notes,
  search,
  searching,
  loadingMore,
  error,
  onSearchChange,
  onLoadMore,
  onRestoreNote,
}: {
  action: CloudAction;
  backup: CloudBackupSnapshot;
  notes: BackupNotesView;
  search: string;
  searching: boolean;
  loadingMore: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onLoadMore: () => Promise<void>;
  onRestoreNote: (
    backup: CloudBackupSnapshot,
    item: CloudBackupSnapshotItem,
  ) => void;
}): JSX.Element {
  const searchTerm = search.trim();
  const normalizedSearch = searchTerm.toLowerCase();
  // The rows always match the box: while the service is still answering, and
  // from a service that predates search and sends every note regardless.
  const visibleItems = normalizedSearch
    ? notes.items.filter((item) =>
        item.path.toLowerCase().includes(normalizedSearch),
      )
    : notes.items;
  // Counts and further pages belong to the service's answer, so they show
  // only once that answer is for the words in the box.
  const answer =
    notes.paging !== null && notes.paging.search === searchTerm
      ? notes.paging
      : null;
  const canLoadMore = answer !== null && answer.page < answer.lastPage;
  const loadedCount =
    answer !== null && notes.items.length < answer.total
      ? `Showing ${notes.items.length.toLocaleString()} of ${answer.total.toLocaleString()} ${answer.search ? "matches" : "notes"}`
      : null;
  const footer =
    searching && visibleItems.length > 0 ? "Searching…" : loadedCount;

  return (
    <div className="border-t border-paper-300/45 bg-paper-100/35 px-5 py-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
          Notes in this backup
        </div>
        {notes.notesTotal > 0 && (
          <input
            type="search"
            aria-label="Search notes in this backup"
            value={search}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onSearchChange(event.target.value)}
            className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent sm:w-72"
            placeholder="Search by name or path"
          />
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger"
        >
          {error}
        </p>
      )}
      {notes.notesTotal === 0 ? (
        <div className="text-sm text-ink-500">
          This backup contains no notes.
        </div>
      ) : visibleItems.length > 0 ? (
        <div className="divide-y divide-paper-300/45 overflow-hidden rounded-xl border border-paper-300/50 bg-paper-50/70">
          {visibleItems.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink-800">
                  {item.path}
                </div>
                <div className="mt-0.5 text-xs text-ink-500">
                  {formatBytes(item.byte_length)} · Revision {item.revision}
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={action !== null}
                onClick={() => onRestoreNote(backup, item)}
              >
                {action === "backup-note-restore"
                  ? "Restoring…"
                  : "Restore note"}
              </Button>
            </div>
          ))}
        </div>
      ) : error ? null : (
        <div className="rounded-xl border border-paper-300/50 bg-paper-50/70 px-4 py-8 text-center text-sm text-ink-500">
          {searching ? (
            "Searching…"
          ) : (
            <>No notes match &quot;{searchTerm}&quot;.</>
          )}
        </div>
      )}
      {(footer || canLoadMore) && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-ink-500">{footer}</p>
          {canLoadMore && (
            <Button
              variant="ghost"
              disabled={action !== null || loadingMore}
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function CloudBackupStatus({
  status,
}: {
  status: CloudBackupSnapshot["status"];
}): JSX.Element {
  const label =
    status === "ready" ? "Ready" : status === "failed" ? "Failed" : "Preparing";
  return (
    <span
      className={
        status === "ready"
          ? "rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
          : status === "failed"
            ? "rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger"
            : "rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
      }
    >
      {label}
    </span>
  );
}

function CloudRestoreResult({
  result,
}: {
  result: CloudBackupRestoreResult;
}): JSX.Element {
  if (result.restore.status === "completed") {
    return (
      <div
        role="status"
        className="rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-ink-700"
      >
        Restored {result.restore.restored_items} items and removed{" "}
        {result.restore.deleted_items} newer items. This vault is synced to
        cursor {result.sync?.cursor ?? result.restore.end_cursor}.
      </div>
    );
  }

  const message =
    result.restore.status === "conflict"
      ? "The cloud vault changed before restore began, so nothing was replaced. Refresh and try again."
      : result.restore.error?.message || "The backup could not be restored.";
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger"
    >
      {message}
    </div>
  );
}

function formatBackupDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function localDateKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function selectBackupsForDate(
  backups: CloudBackupSnapshot[],
  recoveryDate: string,
): { backups: CloudBackupSnapshot[]; notice: string | null } {
  if (!recoveryDate) return { backups, notice: null };

  const readyBackups = backups.filter((backup) => backup.status === "ready");
  const exactBackups = readyBackups.filter(
    (backup) => localDateKey(backup.created_at) === recoveryDate,
  );
  if (exactBackups.length > 0) {
    return { backups: exactBackups, notice: null };
  }

  const [year, month, day] = recoveryDate.split("-").map(Number);
  const endOfSelectedDay = new Date(year, month - 1, day + 1).getTime() - 1;
  const closestEarlierBackup = readyBackups
    .filter(
      (backup) => new Date(backup.created_at).getTime() <= endOfSelectedDay,
    )
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    )[0];

  if (!closestEarlierBackup) {
    return {
      backups: [],
      notice: "No backup is available on or before this date.",
    };
  }

  return {
    backups: [closestEarlierBackup],
    notice: `No backup was created on this date. Showing the closest earlier recovery point from ${formatBackupDate(closestEarlierBackup.created_at)}.`,
  };
}

function formatCloudVaultDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  const elapsedMs = Date.now() - date.getTime();
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return date.toLocaleDateString();
}

// Plans are sold in decimal units (10 GB is 10,000,000,000 bytes), and the
// sync messages count that way too. Dividing by 1024 showed a 10 GB plan as
// "9.3 GB", which read as if the allowance had shrunk.
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  return formatCloudBytes(Math.round(bytes));
}

function pluralize(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function numericLimit(
  limits: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = limits?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Vault settings that differ between this device and the cloud. Notes get a
 * conflict copy to compare side by side, but settings are a single answer, and
 * a copy of them inside a hidden folder is not something anyone can act on.
 * This device's settings stay in use until the question is answered, so doing
 * nothing keeps what is already working. The card names the sections that
 * differ and hands the per-section choice to the shared prompt; the two
 * whole-file answers stay here for the common "just keep mine" case.
 */
function CloudSettingsConflictCard({
  action,
  conflict,
  onResolve,
  onCompare,
}: {
  action: CloudAction;
  conflict: CloudSyncSettingsConflict;
  onResolve: (choice: CloudSyncSettingsChoice) => void;
  onCompare: () => void;
}): JSX.Element {
  const localSettings = useStore((state) => state.vaultSettings);
  const described = conflict.cloud_settings
    ? describeVaultSettingsConflict(localSettings, conflict.cloud_settings)
    : null;
  const sections = described?.differences.map(
    (difference) => VAULT_SETTINGS_SECTION_LABELS[difference.section],
  );
  return (
    <div
      role="group"
      aria-label="Vault settings differ from the cloud"
      className="rounded-xl border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-ink-700"
    >
      <div className="font-medium">Vault settings differ from the cloud</div>
      <div className="mt-1 text-xs leading-5 text-ink-500">
        {sections === undefined
          ? "Another device saved different settings for this vault: favorites, folder icons and colors, and where the built-in folders live."
          : sections.length === 0
            ? "Another device saved settings for this vault that this device reads the same way as its own."
            : `Another device saved different settings for this vault. What differs: ${sections.join(", ")}.`}{" "}
        This device&rsquo;s settings are the ones in use.
        {described !== null && described.unknownKeys.length > 0 && (
          <>
            {" "}
            The cloud&rsquo;s copy also carries settings this device does not use (
            {described.unknownKeys.join(", ")}).
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {sections !== undefined && sections.length > 0 && (
          <Button variant="primary" disabled={action !== null} onClick={onCompare}>
            Compare and choose…
          </Button>
        )}
        <Button
          variant={sections !== undefined && sections.length > 0 ? "secondary" : "primary"}
          disabled={action !== null}
          onClick={() => onResolve("local")}
        >
          {action === "settings-local" ? "Keeping…" : "Keep this device's"}
        </Button>
        <Button
          variant="ghost"
          disabled={action !== null}
          onClick={() => onResolve("cloud")}
        >
          {action === "settings-cloud" ? "Applying…" : "Use the cloud's"}
        </Button>
      </div>
    </div>
  );
}

function CloudSyncSummary({
  summary,
  vaultName,
  onSummaryChange,
  showStatus = true,
}: {
  summary: CloudSyncRunSummary;
  vaultName: string;
  onSummaryChange: (summary: CloudSyncRunSummary) => void;
  showStatus?: boolean;
}): JSX.Element {
  const [selectedPendingConflictId, setSelectedPendingConflictId] = useState<
    string | null
  >(null);
  const attention = cloudSyncAttentionMessage(summary);
  const capacityConflictCount = summary.conflicts.filter((conflict) =>
    [
      "QUOTA_EXCEEDED",
      "CAPACITY_EXCEEDED",
    ].includes(conflict.code) && conflict.capacity?.dimension !== "sync_max_file_bytes",
  ).length;
  const items = cloudSyncAttentionItems(summary);
  // A note opens in the editor behind the modal; anything else (an asset, a
  // settings file) is named so the user knows where to look.
  const canOpen = (path: string): boolean =>
    /\.md$/i.test(path) && !path.toLowerCase().startsWith(".zennotes/");
  const openPath = (path: string): void => {
    const store = useStore.getState();
    store.setSettingsOpen(false);
    // Settings held the keyboard; the note opened behind it takes it now,
    // or typing went nowhere once the modal closed (#863).
    void store.openNoteInTab(path).then(() => focusEditorNormalMode());
  };
  return (
    <div
      role="status"
      className={
        attention
          ? "rounded-xl border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-ink-700"
          : "rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-ink-700"
      }
    >
      {showStatus && (
        <>
          <div className="font-medium">
            {attention
              ? (cloudSyncAttentionLabel(summary) ?? "Sync incomplete")
              : summary.pulled === 0 && summary.pushed === 0
                ? "Everything is up to date"
                : `Downloaded ${summary.pulled} · Uploaded ${summary.pushed}`}
          </div>
          <div className="mt-1 text-xs text-ink-500">
            {attention ?? "All changes are synced."}
          </div>
        </>
      )}
      {capacityConflictCount > 0 && (
        <div className="mt-1 text-xs text-ink-500">
          {capacityConflictCount}{" "}
          {capacityConflictCount === 1 ? "change is" : "changes are"} waiting to
          upload and will retry automatically.
        </div>
      )}
      {items.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Files that need attention">
          {items.map((item) => (
            <li
              key={`${item.kind}:${item.path}`}
              className="rounded-lg border border-paper-300/60 bg-paper-50/60 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div
                    className="truncate font-mono text-xs text-ink-800"
                    title={item.path}
                  >
                    {item.path}
                  </div>
                  <div className="mt-0.5 text-xs leading-5 text-ink-500">
                    {item.detail}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canOpen(item.path) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openPath(item.path)}
                    >
                      Open
                    </Button>
                  )}
                  {item.conflictCopyPath && canOpen(item.conflictCopyPath) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openPath(item.conflictCopyPath!)}
                    >
                      Open copy
                    </Button>
                  )}
                  {item.kind === "pending" && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        setSelectedPendingConflictId(
                          summary.pending_conflicts?.find(
                            (conflict) => conflict.path === item.path,
                          )?.id ?? null,
                        )
                      }
                    >
                      Resolve
                    </Button>
                  )}
                  {item.kind === "legacy" && canOpen(item.path) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void useStore
                          .getState()
                          .trashNote(item.path)
                          .then((moved) => {
                            if (!moved) return;
                            onSummaryChange({
                              ...summary,
                              legacy_conflict_copies:
                                summary.legacy_conflict_copies?.filter(
                                  (copy) => copy.path !== item.path,
                                ) ?? [],
                            });
                          });
                      }}
                    >
                      Move to Trash…
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {selectedPendingConflictId &&
        summary.pending_conflicts?.find(
          (conflict) => conflict.id === selectedPendingConflictId,
        ) && (
          <div className="mt-3 rounded-xl border border-paper-300/60 bg-paper-50 p-3">
            <CloudPendingConflictResolver
              summary={summary}
              // Keyed by conflict: auto-advancing to the next file must not
              // inherit the previous one's copy name or resolved path, which
              // are seeded once from the conflict this resolver opened with.
              key={selectedPendingConflictId}
              conflict={
                summary.pending_conflicts.find(
                  (conflict) => conflict.id === selectedPendingConflictId,
                )!
              }
              vaultName={vaultName}
              onClose={() => setSelectedPendingConflictId(null)}
              onResolved={(nextSummary) => {
                const next = nextSummary.pending_conflicts?.[0] ?? null;
                setSelectedPendingConflictId(next?.id ?? null);
                onSummaryChange(nextSummary);
              }}
            />
          </div>
        )}
    </div>
  );
}

/**
 * Why this vault stopped syncing when nobody here unlinked it. Review on the
 * status row opens the Cloud page at its top, and on a phone This vault sits
 * a long scroll below the account and plan, so the notice brings itself into
 * view.
 */
function CloudVaultRemovedNotice({
  removal,
  vaultsToChoose,
  onDismiss,
}: {
  removal: CloudVaultRemoval;
  vaultsToChoose: boolean;
  onDismiss: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <div
      ref={ref}
      role="status"
      data-cloud-vault-removed=""
      className="flex flex-col gap-3 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">
          {cloudVaultRemovalLabel(removal)}
        </div>
        <p className="mt-1 break-words text-sm leading-6 text-ink-700">
          {cloudVaultRemovalMessage(removal)}{" "}
          {vaultsToChoose
            ? "Choose a cloud vault or start a new one."
            : "Create a new cloud vault to sync it again."}
        </p>
      </div>
      <Button variant="ghost" className="self-start" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** A failed action from This vault, said in This vault and brought into view:
 *  the button that failed can sit a screen below the section's top. */
function CloudSectionError({ message }: { message: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [message]);
  return (
    <div
      ref={ref}
      role="alert"
      data-cloud-vault-error=""
      className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm leading-6 text-danger"
    >
      {message}
    </div>
  );
}

/** The vault chosen from the list was gone by the time it was opened. */
function vaultGoneFromListMessage(vaultName: string | null): string {
  const vault = vaultName ? `“${vaultName}”` : "That cloud vault";
  return `${vault} is no longer in your ZenNotes Cloud account. It may have been deleted on another device. The list below is up to date.`;
}

function CloudNotice({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-2xl border border-paper-300/60 bg-paper-50/45 px-5 py-4 text-sm leading-6 text-ink-500">
      {children}
    </div>
  );
}

function CloudLoadingState({
  compact = false,
}: {
  compact?: boolean;
}): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading ZenNotes Cloud"
      className={compact ? "space-y-2" : "space-y-3 py-2"}
    >
      <div className="h-4 w-40 animate-pulse rounded bg-paper-300/70" />
      <div className="h-14 animate-pulse rounded-2xl bg-paper-200/70" />
    </div>
  );
}

/** Long enough for a phone to finish saving the new credential. */
const CANCELLED_LOAD_RETRY_MS = 300;
const CANCELLED_LOAD_RETRIES = 3;

function isCancelledRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;

  // Electron hands the renderer "<ClassName>: <message>" for a main-process
  // rejection; the class name ("CloudServiceRequestError") is not for people.
  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:[A-Z][A-Za-z]*)?Error:\s*/, "")
    .trim();

  return message || fallback;
}
