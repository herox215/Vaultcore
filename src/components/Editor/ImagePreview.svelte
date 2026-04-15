<script lang="ts">
  // #49 — fit-to-viewport image preview tab.
  // Uses Tauri's asset:// protocol via convertFileSrc(), the same pipeline
  // the embedPlugin already relies on for inline `![[image.png]]` rendering.
  // Larger-than-viewport images scroll inside the container; smaller images
  // sit centered without upscaling.
  import { convertFileSrc } from "@tauri-apps/api/core";

  let { abs }: { abs: string } = $props();

  const src = $derived(convertFileSrc(abs));
  const filename = $derived(abs.split("/").pop() ?? abs);
</script>

<div class="vc-image-preview">
  <img class="vc-image-preview-img" {src} alt={filename} />
</div>

<style>
  .vc-image-preview {
    position: absolute;
    inset: 0;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg);
    padding: 16px;
    box-sizing: border-box;
  }

  .vc-image-preview-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }
</style>
