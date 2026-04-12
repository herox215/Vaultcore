<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { buildExtensions } from "./extensions";

  let {
    content,
    onSave,
  }: {
    content: string;
    onSave: (text: string) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();

  // RESEARCH Risk 3 / RC-01: EditorView must NOT be wrapped in $state.
  // Svelte's reactive Proxy would intercept internal CM6 field access and
  // break the editor's change detection. Use plain `let` instead.
  let view: EditorView | null = null;

  onMount(() => {
    if (!container) return;
    view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: buildExtensions(onSave),
      }),
      parent: container,
    });
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });
</script>

<div bind:this={container} class="vc-cm-editor" data-testid="cm-editor"></div>

<style>
  .vc-cm-editor {
    width: 100%;
    height: 100%;
    background: var(--color-surface);
  }
</style>
