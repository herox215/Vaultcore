<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Settings as SettingsIcon } from "lucide-svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import GraphFilters, { type GraphFilterState } from "./GraphFilters.svelte";
  import GraphForces from "./GraphForces.svelte";
  import { DEFAULT_FORCE_SETTINGS, type ForceSettings } from "./graphRender";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore, type Tab, GRAPH_TAB_PATH } from "../../store/tabStore";
  import { getLinkGraph } from "../../ipc/commands";
  import { listenFileChange } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import type { LocalGraph, GraphNode } from "../../types/links";

  // ── Persistence ─────────────────────────────────────────────────────────────
  const CAMERA_KEY_PREFIX = "vaultcore-graph-camera-";
  const FILTER_KEY_PREFIX = "vaultcore-graph-filters-";
  const FORCES_KEY_PREFIX = "vaultcore-graph-forces-";
  const FROZEN_KEY_PREFIX = "vaultcore-graph-frozen-";

  /**
   * Small synchronous string hash — used to key per-vault localStorage slots.
   * Not cryptographic; just enough to avoid collisions between vaults whose
   * absolute paths only differ at the tail.
   */
  function hashVaultPath(path: string): string {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < path.length; i += 1) {
      h = (h ^ path.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16);
  }

  interface SavedCamera {
    x: number;
    y: number;
    ratio: number;
    angle: number;
  }

  const DEFAULT_FILTERS: GraphFilterState = {
    search: "",
    tags: [],
    folders: [],
    showOrphans: true,
    showUnresolved: true,
    showAttachments: false,
  };

  function loadCamera(vaultPath: string): SavedCamera | null {
    try {
      const raw = localStorage.getItem(CAMERA_KEY_PREFIX + hashVaultPath(vaultPath));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SavedCamera;
      if (
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        typeof parsed.ratio === "number" &&
        typeof parsed.angle === "number"
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  function saveCamera(vaultPath: string, cam: SavedCamera): void {
    try {
      localStorage.setItem(CAMERA_KEY_PREFIX + hashVaultPath(vaultPath), JSON.stringify(cam));
    } catch {
      /* ignore */
    }
  }

  function loadFilters(vaultPath: string): GraphFilterState {
    try {
      const raw = localStorage.getItem(FILTER_KEY_PREFIX + hashVaultPath(vaultPath));
      if (!raw) return { ...DEFAULT_FILTERS };
      const parsed = JSON.parse(raw) as Partial<GraphFilterState>;
      return { ...DEFAULT_FILTERS, ...parsed };
    } catch {
      return { ...DEFAULT_FILTERS };
    }
  }

  function saveFilters(vaultPath: string, s: GraphFilterState): void {
    try {
      localStorage.setItem(FILTER_KEY_PREFIX + hashVaultPath(vaultPath), JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }

  function loadForces(vaultPath: string): ForceSettings {
    try {
      const raw = localStorage.getItem(FORCES_KEY_PREFIX + hashVaultPath(vaultPath));
      if (!raw) return { ...DEFAULT_FORCE_SETTINGS };
      const parsed = JSON.parse(raw) as Partial<ForceSettings>;
      return { ...DEFAULT_FORCE_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_FORCE_SETTINGS };
    }
  }

  function saveForces(vaultPath: string, s: ForceSettings): void {
    try {
      localStorage.setItem(FORCES_KEY_PREFIX + hashVaultPath(vaultPath), JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }

  function loadFrozen(vaultPath: string): boolean {
    try {
      return localStorage.getItem(FROZEN_KEY_PREFIX + hashVaultPath(vaultPath)) === "true";
    } catch {
      return false;
    }
  }

  function saveFrozen(vaultPath: string, frozen: boolean): void {
    try {
      localStorage.setItem(FROZEN_KEY_PREFIX + hashVaultPath(vaultPath), String(frozen));
    } catch {
      /* ignore */
    }
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let vaultPath = $state<string | null>(null);
  let tabs = $state<Tab[]>([]);
  let activeTabId = $state<string | null>(null);

  let data = $state<LocalGraph | null>(null);
  let loading = $state<boolean>(false);
  let errorMessage = $state<string | null>(null);
  let datasetVersion = $state<number>(0);

  let filters = $state<GraphFilterState>({ ...DEFAULT_FILTERS });
  let filtersCollapsed = $state<boolean>(false);
  let forces = $state<ForceSettings>({ ...DEFAULT_FORCE_SETTINGS });
  let frozen = $state<boolean>(false);
  let forcesPanelOpen = $state<boolean>(false);

  let unlistenFileChange: UnlistenFn | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  const REFETCH_DEBOUNCE_MS = 300;

  const unsubVault = vaultStore.subscribe((s) => {
    if (s.currentPath !== vaultPath) {
      vaultPath = s.currentPath;
      if (vaultPath) {
        filters = loadFilters(vaultPath);
        forces = loadForces(vaultPath);
        frozen = loadFrozen(vaultPath);
      }
      // Vault identity changed → refetch with full relayout.
      datasetVersion += 1;
      scheduleRefetch();
    }
  });

  const unsubTabs = tabStore.subscribe((s) => {
    tabs = s.tabs;
    activeTabId = s.activeTabId;
  });

  // Derive the currently active FILE tab's rel path (used as center-node
  // accent in the global graph).
  const activeRelPath = $derived.by<string | null>(() => {
    if (!activeTabId || !vaultPath) return null;
    const t = tabs.find((tab) => tab.id === activeTabId);
    if (!t) return null;
    if (t.type === "graph" || t.filePath === GRAPH_TAB_PATH) return null;
    if (t.filePath.startsWith(vaultPath + "/")) {
      return t.filePath.slice(vaultPath.length + 1);
    }
    return null;
  });

  // Available tag/folder filter options derived from the current dataset.
  const availableTags = $derived.by<string[]>(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const n of data.nodes) {
      if (n.tags) for (const t of n.tags) set.add(t);
    }
    return Array.from(set).sort();
  });

  const availableFolders = $derived.by<string[]>(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const n of data.nodes) {
      if (!n.resolved || !n.path) continue;
      const idx = n.path.indexOf("/");
      if (idx > 0) set.add(n.path.slice(0, idx));
    }
    return Array.from(set).sort();
  });

  // Adjacency cache — used to decide orphan status.
  const orphanSet = $derived.by<Set<string>>(() => {
    if (!data) return new Set();
    const touched = new Set<string>();
    for (const e of data.edges) {
      touched.add(e.from);
      touched.add(e.to);
    }
    const orphans = new Set<string>();
    for (const n of data.nodes) {
      if (n.resolved && !touched.has(n.id)) orphans.add(n.id);
    }
    return orphans;
  });

  // Hover-lookup friendly map of node → its attributes (tags, path, resolved).
  type NodeInfo = { path: string; resolved: boolean; tags: string[]; label: string };
  const nodeInfo = $derived.by<Map<string, NodeInfo>>(() => {
    const m = new Map<string, NodeInfo>();
    if (!data) return m;
    for (const n of data.nodes) {
      m.set(n.id, {
        path: n.path,
        resolved: n.resolved,
        tags: n.tags ?? [],
        label: n.label,
      });
    }
    return m;
  });

  // ── Reducers consumed by GraphCanvas ───────────────────────────────────────
  const DIM_ALPHA = 0.15;
  const HIDE_ALPHA = 0; // treated by applyAlpha as fully transparent

  function dimForNode(id: string): number | undefined {
    const info = nodeInfo.get(id);
    if (!info) return undefined;

    // HIDE via toggles.
    if (!info.resolved && !filters.showUnresolved) return HIDE_ALPHA;
    if (info.resolved && orphanSet.has(id) && !filters.showOrphans) return HIDE_ALPHA;

    // Attachments: placeholder — dataset currently only contains .md files,
    // toggle just respects future payloads that include images. Hide if the
    // path ends with a known image ext and showAttachments is off.
    const lower = info.path.toLowerCase();
    const isAttachment =
      lower.endsWith(".png") ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".gif") ||
      lower.endsWith(".webp") ||
      lower.endsWith(".svg");
    if (isAttachment && !filters.showAttachments) return HIDE_ALPHA;

    // DIM via filters.
    const searchQ = filters.search.trim().toLowerCase();
    if (searchQ.length > 0) {
      const label = info.label.toLowerCase();
      const path = info.path.toLowerCase();
      if (!label.includes(searchQ) && !path.includes(searchQ)) return DIM_ALPHA;
    }

    if (filters.tags.length > 0) {
      const intersects = info.tags.some((t) => filters.tags.includes(t));
      if (!intersects) return DIM_ALPHA;
    }

    if (filters.folders.length > 0) {
      const idx = info.path.indexOf("/");
      const top = idx > 0 ? info.path.slice(0, idx) : "";
      if (!filters.folders.includes(top)) return DIM_ALPHA;
    }

    return undefined;
  }

  // ── Data loading ────────────────────────────────────────────────────────────
  function scheduleRefetch(): void {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void refetch();
    }, REFETCH_DEBOUNCE_MS);
  }

  async function refetch(): Promise<void> {
    if (!vaultPath) {
      data = { nodes: [], edges: [] };
      return;
    }
    loading = true;
    errorMessage = null;
    try {
      data = await getLinkGraph();
    } catch (err) {
      errorMessage =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Graph konnte nicht geladen werden.";
      data = { nodes: [], edges: [] };
    } finally {
      loading = false;
    }
  }

  function onCameraChange(cam: SavedCamera): void {
    if (vaultPath) saveCamera(vaultPath, cam);
  }

  const savedCamera = $derived.by<SavedCamera | null>(() => {
    return vaultPath ? loadCamera(vaultPath) : null;
  });

  function onFiltersChange(next: GraphFilterState): void {
    filters = next;
    if (vaultPath) saveFilters(vaultPath, next);
  }

  function onForcesChange(next: ForceSettings): void {
    forces = next;
    if (vaultPath) saveForces(vaultPath, next);
  }

  function onFrozenChange(next: boolean): void {
    frozen = next;
    if (vaultPath) saveFrozen(vaultPath, next);
  }

  function onNodeClick(_id: string, node: GraphNode): void {
    if (!node.resolved || !vaultPath || !node.path) return;
    tabStore.openTab(`${vaultPath}/${node.path}`);
  }

  // Esc closes the graph tab (but not when the user is inside a text input).
  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    let graphTabId: string | null = null;
    const unsub = tabStore.subscribe((s) => {
      const tab = s.tabs.find((x) => x.type === "graph");
      graphTabId = tab?.id ?? null;
    });
    unsub();
    if (graphTabId) tabStore.closeTab(graphTabId);
  }

  // Re-fetch on file-watcher events that could change link structure.
  onMount(async () => {
    void refetch();
    unlistenFileChange = await listenFileChange((payload) => {
      if (
        payload.kind === "create" ||
        payload.kind === "delete" ||
        payload.kind === "rename" ||
        payload.kind === "modify"
      ) {
        scheduleRefetch();
      }
    });
  });

  // Detect content changes on open tabs whose lastSavedContent moved. Keeps
  // behavior parity with LocalGraphPanel's docVersion debounce for global
  // link structure updates after auto-save.
  let lastSavedSignatures = new Map<string, string>();
  const unsubTabsContent = tabStore.subscribe((s) => {
    let anyChanged = false;
    const nextSig = new Map<string, string>();
    for (const t of s.tabs) {
      if (t.type === "graph") continue;
      nextSig.set(t.id, t.lastSavedContent);
      const prev = lastSavedSignatures.get(t.id);
      if (prev !== undefined && prev !== t.lastSavedContent) {
        anyChanged = true;
      }
    }
    lastSavedSignatures = nextSig;
    if (anyChanged) scheduleRefetch();
  });

  onDestroy(() => {
    unsubVault();
    unsubTabs();
    unsubTabsContent();
    unlistenFileChange?.();
    if (refetchTimer) clearTimeout(refetchTimer);
  });
</script>

<svelte:document onkeydown={handleKeydown} />

<div class="vc-graph-view" role="region" aria-label="Graph-Ansicht">
  {#if errorMessage}
    <div class="vc-graph-empty">{errorMessage}</div>
  {:else if !data || data.nodes.length === 0}
    <div class="vc-graph-empty">
      {loading ? "Graph wird geladen..." : "Keine Notizen im Vault."}
    </div>
  {:else}
    <GraphCanvas
      {data}
      activeId={activeRelPath}
      {savedCamera}
      dimForNode={(id) => dimForNode(id)}
      onNodeClick={onNodeClick}
      {onCameraChange}
      datasetVersion={datasetVersion}
      forceSettings={forces}
      {frozen}
    />
    <GraphFilters
      state={filters}
      availableTags={availableTags}
      availableFolders={availableFolders}
      collapsed={filtersCollapsed}
      onChange={onFiltersChange}
      onCollapsedChange={(c) => (filtersCollapsed = c)}
    />
    <button
      type="button"
      class="vc-graph-forces-btn"
      class:vc-graph-forces-btn--active={forcesPanelOpen}
      onclick={() => (forcesPanelOpen = !forcesPanelOpen)}
      aria-label="Forces"
      aria-pressed={forcesPanelOpen}
      title="Forces"
    >
      <SettingsIcon size={16} strokeWidth={1.75} />
    </button>
    {#if forcesPanelOpen}
      <GraphForces
        settings={forces}
        {frozen}
        onSettingsChange={onForcesChange}
        onFrozenChange={onFrozenChange}
        onClose={() => (forcesPanelOpen = false)}
      />
    {/if}
    {#if loading}
      <div class="vc-graph-loading">Aktualisiere...</div>
    {/if}
  {/if}
</div>

<style>
  .vc-graph-view {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--color-bg);
    overflow: hidden;
  }
  .vc-graph-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .vc-graph-loading {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 10px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-muted);
    pointer-events: none;
  }
  .vc-graph-forces-btn {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 11;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-muted);
    border-radius: 4px;
    cursor: pointer;
  }
  .vc-graph-forces-btn:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .vc-graph-forces-btn--active {
    color: var(--color-accent);
    border-color: var(--color-accent);
    background: var(--color-accent-bg);
  }
</style>
