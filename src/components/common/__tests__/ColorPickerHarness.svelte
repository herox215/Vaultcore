<script lang="ts">
  import ColorPicker from "../ColorPicker.svelte";

  interface Props {
    open: boolean;
    x?: number;
    y?: number;
    value?: string | null;
    onChange?: (v: string | null) => void;
    onClose?: () => void;
  }

  let {
    open,
    x = 100,
    y = 100,
    value = null,
    onChange = () => {},
    onClose = () => {},
  }: Props = $props();
</script>

<ColorPicker {open} {x} {y} {value} {onChange} {onClose} />
