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
  // #357: generation token guards against stale-promise races. When
  // `abs` changes while an async resolve is still in flight, the in-
  // flight promise must NOT install its resolved URL into `src` or
  // into `revokeCurrent` — otherwise it would either revoke the live
  // URL belonging to the new `abs` or clobber `src` with bytes from
  // the previous file. The handler captures `gen` at effect entry
  // and drops its result (revoking the stale blob URL directly) if
  // the capture no longer matches.
  let gen = 0;

  $effect(() => {
    const token = ++gen;
    const result = resolveAttachmentSrc(abs);
    if (typeof result === "string") {
      releaseAttachmentSrc(revokeCurrent);
      revokeCurrent = null;
      src = result;
    } else {
      void result.then((resolved) => {
        if (token !== gen) {
          // Superseded by a newer `abs`; revoke the decrypted copy so
          // it does not leak instead of installing it.
          if (resolved) releaseAttachmentSrc(resolved);
          return;
        }
        releaseAttachmentSrc(revokeCurrent);
        revokeCurrent = resolved;
        src = resolved ?? "";
      });
    }
  });

  onDestroy(() => {
    // Bump `gen` so any in-flight promise for the final `abs` sees a
    // stale token and revokes its own blob URL instead of mutating
    // torn-down state.
    gen++;
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
