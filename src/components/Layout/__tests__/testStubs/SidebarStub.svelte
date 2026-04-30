<script lang="ts">
  // Minimal Sidebar stub: the responsive-collapse test asserts on the
  // drawer container, not on tree internals. A single focusable button is
  // enough to satisfy the focus-first-focusable querySelector.
  let { selectedPath, onSelect, onOpenFile, onOpenContentSearch } = $props<{
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string, opts?: unknown) => void;
    onOpenContentSearch: (q: string) => void;
  }>();
</script>

<button class="vc-sidebar-action-btn" type="button" aria-label="stub-focus-target">stub</button>
