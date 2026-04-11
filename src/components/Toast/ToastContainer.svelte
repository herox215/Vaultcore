<script lang="ts">
  import { toastStore } from "../../store/toastStore";
  import Toast from "./Toast.svelte";
</script>

<div class="vc-toast-container" data-testid="toast-container">
  {#each $toastStore as toast (toast.id)}
    <Toast {toast} />
  {/each}
</div>

<style>
  .vc-toast-container {
    position: fixed;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }
  .vc-toast-container :global(.vc-toast) {
    pointer-events: auto;
  }
</style>
