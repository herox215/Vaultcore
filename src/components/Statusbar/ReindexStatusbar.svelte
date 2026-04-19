<!--
  #201 PR-C — Statusbar strip that surfaces reindex progress to the user.

  Self-hiding: renders nothing while the store is idle so the vault layout
  stays clean for the (usually long) steady-state. Becomes visible on the
  first `scan` / `index` event and disappears again ~3 s after the
  terminal `done` / `cancelled` event (the timer is the only reason the
  component needs local state — everything else is driven by the store).

  Positioning: fixed bottom overlay, z-index above the editor but below
  modals. Doesn't consume a grid row, so the VaultLayout grid stays
  untouched.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { X } from "lucide-svelte";
  import { reindexStore } from "../../store/reindexStore";
  import { cancelReindex } from "../../ipc/commands";
  import type { ReindexPhase } from "../../ipc/events";

  interface ViewModel {
    visible: boolean;
    phase: ReindexPhase | "idle";
    done: number;
    total: number;
    skipped: number;
    embedded: number;
    etaSeconds: number | null;
  }

  const initialVm: ViewModel = {
    visible: false,
    phase: "idle",
    done: 0,
    total: 0,
    skipped: 0,
    embedded: 0,
    etaSeconds: null,
  };

  let vm = $state<ViewModel>({ ...initialVm });
  let hideTimer: number | null = null;

  const unsub = reindexStore.subscribe((s) => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    const isTerminal = s.phase === "done" || s.phase === "cancelled";
    vm = {
      visible: s.phase !== "idle",
      phase: s.phase,
      done: s.done,
      total: s.total,
      skipped: s.skipped,
      embedded: s.embedded,
      etaSeconds: s.etaSeconds,
    };
    if (isTerminal) {
      hideTimer = window.setTimeout(() => {
        vm = { ...initialVm };
        hideTimer = null;
      }, 3000);
    }
  });

  onDestroy(() => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    unsub();
  });

  function percentFor(v: ViewModel): number {
    if (v.total <= 0) return 0;
    return Math.min(100, Math.round((v.done / v.total) * 100));
  }

  function formatEta(seconds: number | null): string {
    if (seconds === null || seconds <= 0) return "—";
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
  }

  function label(v: ViewModel): string {
    switch (v.phase) {
      case "scan":
        return "Durchsuche Vault …";
      case "index":
        return `${v.done.toLocaleString("de-DE")} / ${v.total.toLocaleString("de-DE")}`;
      case "done":
        return `Fertig — ${v.embedded.toLocaleString("de-DE")} Dateien indexiert, ${v.skipped.toLocaleString("de-DE")} übersprungen`;
      case "cancelled":
        return `Abgebrochen — ${v.done.toLocaleString("de-DE")} von ${v.total.toLocaleString("de-DE")} bearbeitet`;
      default:
        return "";
    }
  }

  async function onCancel(): Promise<void> {
    try {
      await cancelReindex();
    } catch (err) {
      console.warn("cancel reindex ipc failed", err);
    }
  }
</script>

{#if vm.visible}
  <div class="vc-reindex-bar" role="status" aria-live="polite" data-testid="reindex-statusbar">
    <div class="vc-reindex-label">Semantik-Index: {label(vm)}</div>
    {#if vm.phase === "index" && vm.total > 0}
      <div class="vc-reindex-progress" aria-hidden="true">
        <div class="vc-reindex-progress-fill" style="width: {percentFor(vm)}%"></div>
      </div>
      <div class="vc-reindex-eta">ETA {formatEta(vm.etaSeconds)}</div>
    {/if}
    {#if vm.phase === "scan" || vm.phase === "index"}
      <button
        type="button"
        class="vc-reindex-cancel"
        onclick={onCancel}
        aria-label="Reindex abbrechen"
        title="Reindex abbrechen"
      ><X size={14} /></button>
    {/if}
  </div>
{/if}

<style>
  .vc-reindex-bar {
    position: fixed;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    min-width: 320px;
    max-width: 640px;
    padding: 6px 10px;
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    column-gap: 10px;
    align-items: center;
    background: var(--color-surface, rgba(30, 30, 30, 0.9));
    color: var(--color-text, #eee);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    font-size: 12px;
    z-index: 40;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
  }

  .vc-reindex-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .vc-reindex-progress {
    height: 4px;
    background: var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: 2px;
    overflow: hidden;
  }

  .vc-reindex-progress-fill {
    height: 100%;
    background: var(--color-accent, #5aa9ff);
    transition: width 200ms ease;
  }

  .vc-reindex-eta {
    font-variant-numeric: tabular-nums;
    color: var(--color-text-muted, #aaa);
    white-space: nowrap;
  }

  .vc-reindex-cancel {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-muted, #aaa);
    cursor: pointer;
  }
  .vc-reindex-cancel:hover,
  .vc-reindex-cancel:focus-visible {
    background: var(--color-border, rgba(255, 255, 255, 0.12));
    color: var(--color-text, #eee);
  }
</style>
