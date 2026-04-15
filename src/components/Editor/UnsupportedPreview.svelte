<script lang="ts">
  // #49 — placeholder shown when a tab's file type has no viewer (binary
  // files: .zip, office docs, etc.). Lists the filename so users know which
  // tab they're on; an explicit "no viewer" message replaces the previous
  // silent toast-and-no-tab failure mode.
  let { abs }: { abs: string } = $props();
  const filename = $derived(abs.split("/").pop() ?? abs);
</script>

<div class="vc-unsupported-preview">
  <div class="vc-unsupported-card">
    <p class="vc-unsupported-heading">Cannot preview this file type</p>
    <p class="vc-unsupported-name">{filename}</p>
    <p class="vc-unsupported-body">
      VaultCore has no built-in viewer for this file. Open it in another
      application from your file manager.
    </p>
  </div>
</div>

<style>
  .vc-unsupported-preview {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg);
    padding: 32px;
    box-sizing: border-box;
  }

  .vc-unsupported-card {
    max-width: 360px;
    text-align: center;
    color: var(--color-text-muted);
  }

  .vc-unsupported-heading {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 8px 0;
    color: var(--color-text);
  }

  .vc-unsupported-name {
    font-size: 14px;
    margin: 0 0 12px 0;
    color: var(--color-text);
    word-break: break-all;
  }

  .vc-unsupported-body {
    font-size: 13px;
    margin: 0;
    line-height: 1.5;
  }
</style>
