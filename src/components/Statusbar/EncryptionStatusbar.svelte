<!--
  #357 — bottom-center pill that surfaces auto-encrypt-on-drop state.

  Distinct from `ReindexStatusbar` (which tracks the semantic reindex
  worker) but clones its geometry and token set exactly. The two pills
  must be able to coexist on screen, so this one sits at `bottom: 48px`
  — 12 px base + ~36 px reindex pill height — and the reindex pill
  keeps its `bottom: 12px`.

  The pill stays silent until the first event arrives, reports
  aggregated progress for the current batch, and auto-dismisses 3 s
  after the last sealed file. Failures persist with a left-border
  accent until the next payload (or until the user triggers another
  drop).
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { encryptionProgressStore, type EncryptionProgressState } from "../../store/encryptionProgressStore";

  const initialVm: EncryptionProgressState = {
    inFlight: 0,
    total: 0,
    lastCompleted: null,
    queued: false,
    error: null,
    visible: false,
  };

  let vm = $state<EncryptionProgressState>({ ...initialVm });
  let hideTimer: number | null = null;

  const unsub = encryptionProgressStore.subscribe((s) => {
    // Cancel any pending auto-dismiss whenever a fresh payload lands.
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    vm = { ...s };
    // Dismiss when the current batch has finished (no error, nothing
    // in flight) — matches the ReindexStatusbar terminal-state
    // behaviour. Errors and queued states persist so the user sees
    // them until another event arrives.
    if (s.visible && s.inFlight === 0 && s.error === null && !s.queued && s.total > 0) {
      hideTimer = window.setTimeout(() => {
        encryptionProgressStore.reset();
        hideTimer = null;
      }, 3000);
    }
    // Queued-into-locked pill auto-dismisses too, but faster (users
    // dropping a batch into a locked folder get one pill per batch).
    if (s.queued && s.error === null) {
      hideTimer = window.setTimeout(() => {
        encryptionProgressStore.reset();
        hideTimer = null;
      }, 4000);
    }
  });

  onDestroy(() => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    unsub();
  });

  function filename(p: string | null): string {
    if (!p) return "";
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  function label(v: EncryptionProgressState): string {
    if (v.error) return `Failed to secure ${filename(v.error.path)}`;
    if (v.queued) {
      return `Queued: ${filename(v.lastCompleted)} — plaintext until unlock`;
    }
    if (v.inFlight > 0) return `Securing ${v.inFlight} file(s)…`;
    if (v.total > 0) return `${v.total} file(s) secured.`;
    return "";
  }
</script>

{#if vm.visible}
  <div
    class="vc-encrypt-bar"
    class:vc-encrypt-bar-error={vm.error !== null}
    class:vc-encrypt-bar-queued={vm.queued && vm.error === null}
    role={vm.error ? "alert" : "status"}
    aria-live={vm.error ? "assertive" : "polite"}
    data-testid="encryption-statusbar"
  >
    <div class="vc-encrypt-label">Encryption: {label(vm)}</div>
  </div>
{/if}

<style>
  .vc-encrypt-bar {
    position: fixed;
    left: 50%;
    /* Stack above the reindex pill (which sits at bottom: 12px) so the
       two can coexist on screen simultaneously. */
    bottom: 48px;
    transform: translateX(-50%);
    min-width: 320px;
    max-width: 640px;
    padding: 6px 10px;
    display: grid;
    grid-template-columns: 1fr;
    align-items: center;
    background: var(--color-surface, rgba(30, 30, 30, 0.9));
    color: var(--color-text, #eee);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    font-size: 12px;
    z-index: 40;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
  }

  .vc-encrypt-bar-error {
    /* #357 — 4 px accent matches the error-variant toast contract. */
    border-left: 4px solid var(--color-error, #d9534f);
    padding-left: 6px;
  }

  .vc-encrypt-bar-queued {
    border-left: 4px solid var(--color-warning, #d9a84f);
    padding-left: 6px;
  }

  .vc-encrypt-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
