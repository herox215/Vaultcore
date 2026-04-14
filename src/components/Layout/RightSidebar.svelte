<script lang="ts">
  import BacklinksPanel from "../Backlinks/BacklinksPanel.svelte";
  import OutgoingLinksPanel from "../OutgoingLinks/OutgoingLinksPanel.svelte";
  import OutlinePanel from "../Outline/OutlinePanel.svelte";
  import PropertiesPanel from "../Properties/PropertiesPanel.svelte";
</script>
<div class="vc-right-sidebar">
  <PropertiesPanel />
  <OutlinePanel />
  <OutgoingLinksPanel />
  <div class="vc-right-sidebar-backlinks">
    <BacklinksPanel />
  </div>
</div>
<style>
  .vc-right-sidebar {
    height: 100%;
    overflow: hidden;
    background: var(--color-bg);
    display: flex;
    flex-direction: column;
  }
  .vc-right-sidebar-backlinks {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
