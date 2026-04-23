<script lang="ts">
  import type { Toast, ToastVariant } from "../../store/toastStore";
  import { toastStore } from "../../store/toastStore";

  let { toast }: { toast: Toast } = $props();

  const icon: Record<ToastVariant, string> = {
    error: "✕",
    conflict: "⚠",
    "clean-merge": "✓",
    info: "ℹ",
  };

  const borderColor: Record<ToastVariant, string> = {
    error: "var(--color-error)",
    conflict: "var(--color-warning)",
    "clean-merge": "var(--color-success)",
    info: "var(--color-accent)",
  };
</script>

<div
  class="vc-toast"
  data-testid="toast"
  data-variant={toast.variant}
  role="status"
  aria-live="polite"
  style:border-left-color={borderColor[toast.variant]}
>
  <span class="vc-toast-icon" aria-hidden="true">{icon[toast.variant]}</span>
  <span class="vc-toast-message">{toast.message}</span>
  <button
    type="button"
    class="vc-toast-dismiss"
    aria-label="Dismiss notification"
    onclick={() => toastStore.dismiss(toast.id)}
  >×</button>
</div>

<style>
  .vc-toast {
    width: 320px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-left-width: 4px;
    border-radius: 8px;
    padding: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: center;
    color: var(--color-text);
    font-size: 14px;
    line-height: 1.5;
    font-family: var(--vc-font-body);
  }
  .vc-toast-icon {
    font-weight: 700;
    min-width: 16px;
    text-align: center;
  }
  .vc-toast-message {
    word-break: break-word;
  }
  .vc-toast-dismiss {
    background: none;
    border: none;
    font-size: 16px;
    line-height: 1;
    color: var(--color-text-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .vc-toast-dismiss:hover {
    color: var(--color-text);
  }
  .vc-toast-dismiss:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
</style>
