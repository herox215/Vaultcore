<!--
  UI-4 — ambient sync status indicator.

  Stacked above EncryptionStatusbar (`bottom: 48px`) at `bottom: 84px`
  per the existing 12 / 48 / 84 stacking convention. Hidden when sync
  is idle and healthy across every vault. While syncing, surfaces an
  aggregated peer + in-flight-file count. On error, becomes a button
  that opens Settings on the SYNCHRONISIERUNG section.

  Geometry / tokens cloned from EncryptionStatusbar; no new design tokens.
-->
<script lang="ts">
  import { syncStatusByVault } from "../../store/syncStore";
  import { requestOpenSettings } from "../../store/settingsModalStore";

  type Mode = "idle" | "syncing" | "error";

  // Aggregate worst-state across vaults: error > syncing > idle.
  // Sums are computed across all reporting vaults so users with
  // multiple vaults paired see one consolidated pill.
  const vm = $derived.by(() => {
    const statuses = Object.values($syncStatusByVault);
    let mode: Mode = "idle";
    let peers = 0;
    let files = 0;
    for (const s of statuses) {
      peers += s.peer_count;
      files += s.in_flight_files;
      if (s.error) {
        mode = "error";
      } else if (mode !== "error" && (s.peer_count > 0 || s.in_flight_files > 0)) {
        mode = "syncing";
      }
    }
    return { mode, peers, files };
  });

  function onErrorClick(): void {
    requestOpenSettings("sync");
  }
</script>

{#if vm.mode === "error"}
  <!-- Vitruvius constraint: error pill is a `<button>` AND carries
       role="alert" + aria-live="assertive" so the label announces
       immediately when sync fails. Svelte's a11y lint flags this
       because alert is canonically non-interactive — the constraint
       overrides because the user must be able to click straight to
       Settings without a separate live region. -->
  <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
  <button
    type="button"
    class="vc-encrypt-bar vc-encrypt-bar-error"
    onclick={onErrorClick}
    role="alert"
    aria-live="assertive"
    aria-label="Synchronisierungsfehler — Einstellungen öffnen"
    data-testid="sync-status-pill"
  >
    <div class="vc-encrypt-label">Synchronisierungsfehler · Einstellungen öffnen</div>
  </button>
{:else if vm.mode === "syncing"}
  <div
    class="vc-encrypt-bar"
    role="status"
    aria-live="polite"
    data-testid="sync-status-pill"
  >
    <div class="vc-encrypt-label">{vm.peers} verbunden · {vm.files} Dateien</div>
  </div>
{/if}

<style>
  /* Geometry mirrors `.vc-encrypt-bar` in EncryptionStatusbar; the only
     delta is `bottom` (84 vs 48) so the two pills can coexist on screen.
     Token set is identical — no new design tokens introduced. */
  .vc-encrypt-bar {
    position: fixed;
    left: 50%;
    bottom: 84px;
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
    /* Reset native button defaults for the error variant. */
    font-family: inherit;
    text-align: left;
    cursor: default;
  }
  button.vc-encrypt-bar { cursor: pointer; }
  button.vc-encrypt-bar:hover { background: var(--color-accent-bg, rgba(255,255,255,0.05)); }

  .vc-encrypt-bar-error {
    border-left: 4px solid var(--color-error, #d9534f);
    padding-left: 6px;
  }

  .vc-encrypt-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
