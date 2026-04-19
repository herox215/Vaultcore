<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { themeStore } from "./store/themeStore";
  import { settingsStore } from "./store/settingsStore";
  import { vaultStore } from "./store/vaultStore";
  import { tabStore } from "./store/tabStore";
  import { toastStore } from "./store/toastStore";
  import { progressStore } from "./store/progressStore";
  import { snippetsStore } from "./store/snippetsStore";
  import {
    getRecentVaults,
    openVault,
    pickVaultFolder,
    repairVaultIndex,
    reindexVault,
  } from "./ipc/commands";
  import { listenIndexProgress, listenReindexProgress } from "./ipc/events";
  import { reindexStore } from "./store/reindexStore";
  import { isVaultError, vaultErrorCopy } from "./types/errors";
  import type { RecentVault } from "./types/vault";
  import "./types/e2e-hook";
  import WelcomeScreen from "./components/Welcome/WelcomeScreen.svelte";
  import VaultLayout from "./components/Layout/VaultLayout.svelte";
  import ToastContainer from "./components/Toast/ToastContainer.svelte";
  import ProgressBar from "./components/Progress/ProgressBar.svelte";

  let recent: RecentVault[] = $state([]);
  let unlistenProgress: (() => void) | null = null;
  let unlistenReindex: (() => void) | null = null;

  // Custom CSS snippets (#64): keep one HTMLStyleElement per enabled snippet
  // mounted at the top of document.head, tagged with data-snippet="<filename>".
  // We manage these imperatively because Svelte template style blocks are
  // compiler-scoped — inline CSS text can't be piped into them at runtime.
  // Reacting to the store keeps toggling instant (no restart, no remount).
  const SNIPPET_ATTR = "data-snippet";
  const unsubSnippets = snippetsStore.subscribe((s) => {
    // Run after Svelte finishes mounting so document.head exists during SSR-like
    // early ticks (unit tests / jsdom). Defer to a microtask if head isn't ready.
    if (typeof document === "undefined") return;
    const head = document.head;
    if (!head) return;
    const active = s.enabled.filter((name) => s.contents[name] !== undefined);
    const activeSet = new Set(active);
    // Remove tags for snippets that are no longer enabled or whose contents
    // disappeared (e.g. the file was deleted on disk).
    const existing = head.querySelectorAll(`style[${SNIPPET_ATTR}]`);
    for (const el of Array.from(existing)) {
      const name = el.getAttribute(SNIPPET_ATTR) ?? "";
      if (!activeSet.has(name)) el.remove();
    }
    // Add / update tags for everything that should be active now.
    for (const name of active) {
      const css = s.contents[name] ?? "";
      let el = head.querySelector<HTMLStyleElement>(
        `style[${SNIPPET_ATTR}="${CSS.escape(name)}"]`,
      );
      if (!el) {
        el = document.createElement("style");
        el.setAttribute(SNIPPET_ATTR, name);
        head.appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
    }
  });

  // Index-corrupt recovery dialog — shown when openVault fails with
  // IndexCorrupt. Confirming wipes .vaultcore/index/tantivy + the version
  // stamp and retries openVault, which rebuilds from scratch.
  let repairPrompt = $state<{ vaultPath: string } | null>(null);
  let repairing = $state(false);

  function toVaultError(err: unknown) {
    if (isVaultError(err)) {
      return { kind: err.kind, message: err.message, data: err.data ?? null };
    }
    return { kind: "Io" as const, message: String(err), data: null };
  }

  async function loadVault(path: string): Promise<void> {
    vaultStore.setOpening(path);
    progressStore.start(0);
    try {
      const info = await openVault(path);
      vaultStore.setReady({
        currentPath: info.path,
        fileList: info.file_list,
        fileCount: info.file_count,
      });
      progressStore.finish();
      // Refresh recent-vaults list so the just-opened entry floats to the top
      // next time the Welcome card is shown.
      recent = await getRecentVaults();
      // Snippets are per-vault — reload the enabled set and CSS text now
      // that we know which vault is active.
      void snippetsStore.load(info.path);
    } catch (err) {
      progressStore.finish();
      const ve = toVaultError(err);
      if (ve.kind === "IndexCorrupt") {
        // Offer the user an in-app repair rather than making them delete
        // .vaultcore/index by hand.
        repairPrompt = { vaultPath: path };
        vaultStore.setError(vaultErrorCopy(ve));
        return;
      }
      vaultStore.setError(vaultErrorCopy(ve));
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function confirmRepair(): Promise<void> {
    if (!repairPrompt || repairing) return;
    repairing = true;
    const path = repairPrompt.vaultPath;
    try {
      await repairVaultIndex(path);
      repairPrompt = null;
      repairing = false;
      await loadVault(path);
    } catch (err) {
      repairing = false;
      const ve = toVaultError(err);
      toastStore.push({
        variant: "error",
        message: `Repair failed: ${vaultErrorCopy(ve)}`,
      });
    }
  }

  function cancelRepair(): void {
    repairPrompt = null;
  }

  async function handlePickVault(): Promise<void> {
    try {
      const picked = await pickVaultFolder();
      if (picked !== null) {
        await loadVault(picked);
      }
    } catch (err) {
      const ve = toVaultError(err);
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleSwitchVault(): Promise<void> {
    try {
      const picked = await pickVaultFolder();
      if (picked === null) return;
      let currentPath: string | null = null;
      const unsub = vaultStore.subscribe((s) => { currentPath = s.currentPath; });
      unsub();
      if (currentPath === picked) return;
      tabStore.closeAll();
      // Let EditorPane's $effect observe the now-empty tab list and destroy
      // the old CM6 views before we resolve the new vault (#39). Without
      // this tick, mountEditorView can race the reactive unmount — its
      // paneEl.querySelector lookup silently returns null if the new tab's
      // container hasn't materialised yet, leaving the editor blank.
      await tick();
      await loadVault(picked);
    } catch (err) {
      const ve = toVaultError(err);
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function handleOpenRecent(path: string): void {
    void loadVault(path);
  }

  onMount(async () => {
    themeStore.init();
    settingsStore.init();

    // Subscribe to progress events before any vault open happens
    unlistenProgress = await listenIndexProgress((payload) => {
      progressStore.update(payload.current, payload.total, payload.current_file);
    });

    // #201: pipe semantic-reindex progress events into the reindexStore so
    // the statusbar overlay and settings modal can reflect live state.
    unlistenReindex = await listenReindexProgress((payload) => {
      reindexStore.apply(payload);
    });

    // E2E test hook: expose loadVault + switchVault on window so WebDriver
    // specs can bypass the native file picker. Gated behind VITE_E2E=1 so
    // the hook is completely absent from normal release builds (tree-shaken
    // out). switchVault mirrors handleSwitchVault but takes the target path
    // directly — use it when a test needs to transition between two vaults.
    if (import.meta.env.VITE_E2E === "1") {
      const switchVault = async (path: string): Promise<void> => {
        let currentPath: string | null = null;
        const unsub = vaultStore.subscribe((s) => { currentPath = s.currentPath; });
        unsub();
        if (currentPath === path) return;
        tabStore.closeAll();
        await tick();
        await loadVault(path);
      };
      const closeVault = async (): Promise<void> => {
        tabStore.closeAll();
        vaultStore.reset();
        await tick();
      };
      const pushToast = (variant: "error" | "conflict" | "clean-merge", message: string): void => {
        toastStore.push({ variant: variant, message: message });
      };
      const startProgress = (total: number): void => {
        progressStore.start(total);
      };
      const updateProgress = (current: number, total: number, currentFile?: string): void => {
        progressStore.update(current, total, currentFile ?? "");
      };
      const finishProgress = (): void => {
        progressStore.finish();
      };
      // Type-into-active-editor hook. WebKit driver keystrokes don't reach
      // CM6 contenteditable reliably, so we dispatch a transaction against
      // the EditorView resolved from the currently visible .cm-content.
      const typeInActiveEditor = async (text: string): Promise<void> => {
        const { EditorView } = await import("@codemirror/view");
        const els = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
        const active = els.find((el) => el.offsetParent !== null);
        if (!active) return;
        const view = EditorView.findFromDOM(active);
        if (!view) return;
        view.focus();
        const pos = view.state.doc.length;
        view.dispatch({
          changes: { from: pos, to: pos, insert: text },
          selection: { anchor: pos + text.length },
          userEvent: "input.type",
        });
      };
      // Read the current CM6 document text from the visible editor. WebKit
      // drivers can't introspect CM6 state directly, so the hook resolves the
      // active EditorView and returns `view.state.doc.toString()`.
      const getActiveDocText = async (): Promise<string> => {
        const { EditorView } = await import("@codemirror/view");
        const els = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
        const active = els.find((el) => el.offsetParent !== null);
        if (!active) return "";
        const view = EditorView.findFromDOM(active);
        if (!view) return "";
        return view.state.doc.toString();
      };
      // #204: subscribe once to the reindex-done signal so E2E specs can
      // wait for embeddings to be queryable before running a semantic-only
      // search. We keep a single listener for the lifetime of the window
      // and broadcast the terminal phase to any pending waiter.
      const { listenReindexProgress: listenReindex } = await import("./ipc/events");
      const waiters: Array<(result: "done" | "cancelled") => void> = [];
      await listenReindex((payload) => {
        if (payload.phase === "done" || payload.phase === "cancelled") {
          const pending = waiters.splice(0);
          for (const resolve of pending) resolve(payload.phase);
        }
      });
      const reindexAndWaitDone = (): Promise<void> =>
        new Promise((resolve, reject) => {
          waiters.push((phase) => {
            if (phase === "done") resolve();
            else reject(new Error(`reindex ended with phase=${phase}`));
          });
          reindexVault().catch(reject);
        });
      window.__e2e__ = {
        loadVault,
        switchVault,
        closeVault,
        pushToast,
        startProgress,
        updateProgress,
        finishProgress,
        typeInActiveEditor,
        getActiveDocText,
        reindexAndWaitDone,
      };
    }

    // VAULT-03: on startup, attempt to reopen the most-recent reachable vault.
    // VAULT-05: if that vault has been moved/deleted/unmounted, we stay on the
    // Welcome screen and surface a toast instead of crashing.
    try {
      recent = await getRecentVaults();
      const last = recent[0];
      // Skip auto-load in e2e mode so each spec controls its own vault.
      if (last !== undefined && import.meta.env.VITE_E2E !== "1") {
        await loadVault(last.path);
      }
    } catch (err) {
      const ve = toVaultError(err);
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  });

  onDestroy(() => {
    unlistenProgress?.();
    unlistenReindex?.();
    unsubSnippets();
  });
</script>

{#if $vaultStore.status === "ready"}
  <VaultLayout onSwitchVault={handleSwitchVault} />
{:else}
  <WelcomeScreen
    {recent}
    onOpenVault={handleOpenRecent}
    onPickVault={handlePickVault}
  />
{/if}

<ProgressBar />
<ToastContainer />

{#if repairPrompt}
  <div class="vc-repair-backdrop" role="dialog" aria-modal="true" aria-labelledby="vc-repair-title">
    <div class="vc-repair-modal">
      <h2 id="vc-repair-title" class="vc-repair-title">Index corrupt</h2>
      <p class="vc-repair-body">
        The search index for this vault can't be opened. VaultCore can wipe
        <code>.vaultcore/index/tantivy</code> and rebuild it from scratch —
        your notes are not touched.
      </p>
      <div class="vc-repair-actions">
        <button type="button" class="vc-repair-cancel" onclick={cancelRepair} disabled={repairing}>
          Cancel
        </button>
        <button type="button" class="vc-repair-confirm" onclick={confirmRepair} disabled={repairing}>
          {repairing ? "Rebuilding…" : "Rebuild index"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .vc-repair-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }
  .vc-repair-modal {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    padding: 20px 24px;
    max-width: 440px;
    width: calc(100% - 48px);
  }
  .vc-repair-title {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 700;
    color: var(--color-text);
  }
  .vc-repair-body {
    margin: 0 0 20px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--color-text);
  }
  .vc-repair-body code {
    font-family: var(--vc-font-mono);
    font-size: 12px;
    padding: 1px 4px;
    background: var(--color-surface-alt, rgba(0, 0, 0, 0.06));
    border-radius: 3px;
  }
  .vc-repair-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .vc-repair-cancel,
  .vc-repair-confirm {
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
  }
  .vc-repair-confirm {
    background: var(--color-accent);
    color: white;
    border-color: var(--color-accent);
  }
  .vc-repair-cancel:disabled,
  .vc-repair-confirm:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
