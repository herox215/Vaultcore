<script lang="ts">
  // #49 — fit-to-viewport image preview tab.
  // #357 — routes encrypted-folder attachments through
  // `resolveAttachmentSrc` so decrypted bytes render via blob: URL
  // without ever hitting the plaintext asset:// protocol.
  import { onDestroy } from "svelte";

  import { resolveAttachmentSrc, releaseAttachmentSrc } from "./attachmentSource";

  let { abs }: { abs: string } = $props();

  let src = $state<string>("");
  let revokeCurrent: string | null = null;

  $effect(() => {
    const result = resolveAttachmentSrc(abs);
    // Release the previous blob URL (if any) before assigning the new
    // one so decrypted bytes don't accumulate in the browser's blob
    // store across successive note switches.
    if (typeof result === "string") {
      releaseAttachmentSrc(revokeCurrent);
      revokeCurrent = null;
      src = result;
    } else {
      // Async (encrypted folder). Assign after the promise resolves;
      // revoke the previous URL on success OR failure.
      void result.then((resolved) => {
        releaseAttachmentSrc(revokeCurrent);
        revokeCurrent = resolved;
        src = resolved ?? "";
      });
    }
  });

  onDestroy(() => {
    releaseAttachmentSrc(revokeCurrent);
    revokeCurrent = null;
  });

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
