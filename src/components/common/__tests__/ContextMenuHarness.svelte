<script lang="ts">
  import ContextMenu from "../ContextMenu.svelte";

  interface Props {
    open: boolean;
    x: number;
    y: number;
    label: string;
    onClose?: () => void;
  }

  let { open, x, y, label, onClose = () => {} }: Props = $props();
</script>

<ContextMenu {open} {x} {y} {onClose}>
  <button class="vc-context-item">{label}</button>
</ContextMenu>
