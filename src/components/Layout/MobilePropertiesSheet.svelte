<script lang="ts">
  /**
   * MobilePropertiesSheet — mobile bottom-sheet wrapper for the
   * Properties / frontmatter panel (#393).
   *
   * Parent-gated: VaultLayout decides via `{#if isMobile}` when to render
   * and owns the `open` flag. The component itself does NOT subscribe to
   * viewportStore — same convention as MobileBurgerSheet (#397).
   *
   * Body: the existing `<PropertiesPanel />` is embedded as-is. It
   * subscribes to `activeViewStore` directly, so frontmatter editing
   * lands on whatever CM6 view is active in the editor pane behind the
   * scrim — no prop wiring needed.
   *
   * Keyboard-aware lift via `--vc-keyboard-height` (#395):
   *   - The sheet is positioned `bottom: var(--vc-keyboard-height, 0px)`
   *     so it lifts above the on-screen keyboard when the user taps into
   *     a frontmatter input.
   *   - `max-height` ALSO subtracts the keyboard height so the sheet
   *     doesn't extend behind the keyboard (otherwise the visible top
   *     would be pushed up while the bottom rows stayed hidden).
   *   - On desktop / closed-keyboard mobile the var is 0px → byte-
   *     identical to the burger sheet's bottom-anchored placement.
   *
   * Drag-handle is a pure visual affordance per the burger precedent
   * — swipe-to-dismiss gesture is deferred (scrim-tap + ESC cover
   * dismissal). Follow-up if UAT requests.
   *
   * z-index hierarchy:
   *   drawer 50  <  scrim 49
   *      burger scrim 59  /  sheet 60
   *      properties scrim 69  /  sheet 70
   *      modals 199+
   */
  import PropertiesPanel from "../Properties/PropertiesPanel.svelte";

  let {
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();

  // bind:this writes the live DOM node here. Svelte 5 wants a $state
  // target even for imperative refs because the keydown trap reads it
  // from inside reactive scope — same pattern as burger sheet's sheetEl.
  let sheetEl = $state<HTMLDivElement | undefined>(undefined);

  // Focus the first focusable inside the sheet on open. Microtask wait
  // so CSS class application paints before focus jumps. Mirrors burger.
  $effect(() => {
    if (open) {
      queueMicrotask(() => {
        const first = sheetEl?.querySelector<HTMLElement>(
          'button:not([tabindex="-1"]), a:not([tabindex="-1"]), input:not([tabindex="-1"])',
        );
        first?.focus();
      });
    }
  });

  // Standard keyboard-trap selector — anything that can take focus,
  // minus explicitly disabled or programmatically-only-focusable nodes.
  const FOCUSABLE_SELECTOR = [
    'button:not([disabled]):not([tabindex="-1"])',
    'a[href]:not([tabindex="-1"])',
    'input:not([disabled]):not([tabindex="-1"])',
    'select:not([disabled]):not([tabindex="-1"])',
    'textarea:not([disabled]):not([tabindex="-1"])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  function focusables(): HTMLElement[] {
    if (!sheetEl) return [];
    return Array.from(sheetEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      // Focus trap: keep keyboard navigation inside the dialog. Without
      // this, Shift+Tab from the first input (or Tab from the last)
      // escapes into the editor behind the scrim.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

{#if open}
  <!-- Scrim sits below the sheet (z-index 69 vs 70). Tapping closes. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="vc-modal-scrim vc-mobile-properties-scrim"
    aria-hidden="true"
    tabindex="-1"
    onclick={onClose}
  ></div>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="vc-mobile-properties-sheet"
    bind:this={sheetEl}
    role="dialog"
    aria-modal="true"
    aria-label="Eigenschaften"
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <div class="vc-mobile-properties-handle" aria-hidden="true"></div>
    <div class="vc-mobile-properties-body">
      <PropertiesPanel />
    </div>
  </div>
{/if}

<style>
  .vc-mobile-properties-scrim {
    z-index: 69;
  }

  .vc-mobile-properties-sheet {
    position: fixed;
    bottom: var(--vc-keyboard-height, 0px);
    left: 0;
    right: 0;
    height: 70vh;
    /* Subtract the keyboard height too so the sheet's TOP doesn't
       overflow above the visual viewport — without this the visible
       top edge gets pushed off-screen when the keyboard is open. */
    max-height: calc(100vh - 80px - var(--vc-keyboard-height, 0px));
    background: var(--color-surface);
    border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
    z-index: 70;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
    /* Match drawer + burger animation cadence. Animates the lift over
       the keyboard so the transition feels coordinated with the
       keyboard's own slide-in. */
    transition: bottom 240ms cubic-bezier(0.4, 0, 0.2, 1),
                max-height 240ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .vc-mobile-properties-handle {
    width: 36px;
    height: 4px;
    margin: 8px auto 12px auto;
    border-radius: 2px;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .vc-mobile-properties-body {
    flex: 1;
    overflow-y: auto;
  }
</style>
