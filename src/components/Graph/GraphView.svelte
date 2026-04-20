<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Settings as SettingsIcon } from "lucide-svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import GraphFilters, { type GraphFilterState } from "./GraphFilters.svelte";
  import GraphForces from "./GraphForces.svelte";
  import {
    DEFAULT_FORCE_SETTINGS,
    DEFAULT_EMBEDDING_FORCE_SETTINGS,
    type ForceSettings,
  } from "./graphRender";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore, type Tab, GRAPH_TAB_PATH } from "../../store/tabStore";
  import { getEmbeddingGraph, getLinkGraph } from "../../ipc/commands";
  import { listenFileChange } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import type { LocalGraph, GraphNode } from "../../types/links";
  import { clusterGraph } from "./clusterGraph";
  import { tabContentSignature } from "./graphVisibility";

  // ── Persistence ─────────────────────────────────────────────────────────────
  const CAMERA_KEY_PREFIX = "vaultcore-graph-camera-";
  const FILTER_KEY_PREFIX = "vaultcore-graph-filters-";
  // #288 — force settings persist per (vault, mode). The link-mode key
  // stays under the original prefix for backward compatibility with
  // previously-saved settings; embedding mode lives under its own slot
  // with its own defaults tuned for dense graphs.
  const FORCES_KEY_PREFIX = "vaultcore-graph-forces-";
  const FORCES_EMBEDDING_KEY_PREFIX = "vaultcore-graph-forces-embedding-";
  const FROZEN_KEY_PREFIX = "vaultcore-graph-frozen-";
  // #235 — embedding-mode persistence keys.
  const MODE_KEY_PREFIX = "vaultcore-graph-mode-";
  const THRESHOLD_KEY_PREFIX = "vaultcore-graph-threshold-";
  // #237 — second embedding-mode slider: cluster-collapse threshold.
  const CLUSTER_KEY_PREFIX = "vaultcore-graph-cluster-";

  // #235 — embedding-mode constants. `top_k` is fixed in v1; widen the
  // slider to 0.30 so users can deliberately surface looser relations
  // (multilingual-e5-small real semantic matches sit at 0.4–0.8 per the
  // semantic-search noise floor in `query.rs`).
  type GraphMode = "link" | "embedding";
  const EMBEDDING_TOP_K = 10;
  const EMBEDDING_THRESHOLD_MIN = 0.3;
  const EMBEDDING_THRESHOLD_MAX = 0.95;
  const EMBEDDING_THRESHOLD_DEFAULT = 0.7;
  const EMBEDDING_THRESHOLD_STEP = 0.05;

  // #237 — cluster slider. Right edge (= 1.0) disables clustering. Min
  // value sits at 0.55 so the user never sees an effectively useless
  // sub-edge-threshold range; the actual lower bound is clamped to the
  // current edge threshold at runtime (clusterThresholdMin below).
  const CLUSTER_THRESHOLD_ABS_MIN = 0.55;
  const CLUSTER_THRESHOLD_MAX = 1.0;
  const CLUSTER_THRESHOLD_DEFAULT = 1.0;
  const CLUSTER_THRESHOLD_STEP = 0.05;
  const CLUSTER_DEBOUNCE_MS = 200;

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

  /** #288 — resolve the correct (storage key, default) pair for a mode. */
  function forcesSlotFor(mode: GraphMode, vaultPath: string): {
    key: string;
    defaults: ForceSettings;
  } {
    const hash = hashVaultPath(vaultPath);
    return mode === "embedding"
      ? { key: FORCES_EMBEDDING_KEY_PREFIX + hash, defaults: DEFAULT_EMBEDDING_FORCE_SETTINGS }
      : { key: FORCES_KEY_PREFIX + hash, defaults: DEFAULT_FORCE_SETTINGS };
  }

  function loadForces(vaultPath: string, mode: GraphMode): ForceSettings {
    const { key, defaults } = forcesSlotFor(mode, vaultPath);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw) as Partial<ForceSettings>;
      return { ...defaults, ...parsed };
    } catch {
      return { ...defaults };
    }
  }

  function saveForces(vaultPath: string, mode: GraphMode, s: ForceSettings): void {
    try {
      const { key } = forcesSlotFor(mode, vaultPath);
      localStorage.setItem(key, JSON.stringify(s));
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

  function loadMode(vaultPath: string): GraphMode {
    try {
      const raw = localStorage.getItem(MODE_KEY_PREFIX + hashVaultPath(vaultPath));
      return raw === "embedding" ? "embedding" : "link";
    } catch {
      return "link";
    }
  }

  function saveMode(vaultPath: string, m: GraphMode): void {
    try {
      localStorage.setItem(MODE_KEY_PREFIX + hashVaultPath(vaultPath), m);
    } catch {
      /* ignore */
    }
  }

  function loadThreshold(vaultPath: string): number {
    try {
      const raw = localStorage.getItem(THRESHOLD_KEY_PREFIX + hashVaultPath(vaultPath));
      if (!raw) return EMBEDDING_THRESHOLD_DEFAULT;
      const n = Number(raw);
      if (!Number.isFinite(n)) return EMBEDDING_THRESHOLD_DEFAULT;
      return Math.min(EMBEDDING_THRESHOLD_MAX, Math.max(EMBEDDING_THRESHOLD_MIN, n));
    } catch {
      return EMBEDDING_THRESHOLD_DEFAULT;
    }
  }

  function saveThreshold(vaultPath: string, t: number): void {
    try {
      localStorage.setItem(THRESHOLD_KEY_PREFIX + hashVaultPath(vaultPath), String(t));
    } catch {
      /* ignore */
    }
  }

  function loadClusterThreshold(vaultPath: string): number {
    try {
      const raw = localStorage.getItem(CLUSTER_KEY_PREFIX + hashVaultPath(vaultPath));
      if (!raw) return CLUSTER_THRESHOLD_DEFAULT;
      const n = Number(raw);
      if (!Number.isFinite(n)) return CLUSTER_THRESHOLD_DEFAULT;
      return Math.min(CLUSTER_THRESHOLD_MAX, Math.max(CLUSTER_THRESHOLD_ABS_MIN, n));
    } catch {
      return CLUSTER_THRESHOLD_DEFAULT;
    }
  }

  function saveClusterThreshold(vaultPath: string, t: number): void {
    try {
      localStorage.setItem(CLUSTER_KEY_PREFIX + hashVaultPath(vaultPath), String(t));
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

  // #235 — embedding-mode state.
  let mode = $state<GraphMode>("link");
  let embeddingThreshold = $state<number>(EMBEDDING_THRESHOLD_DEFAULT);
  // Discriminator for "embeddings not initialised" vs "no edges over
  // threshold": the backend returns an empty payload for the former
  // (vault not open, embeddings subsystem missing, sink empty). When in
  // embedding mode and the response has zero nodes, we surface that as
  // a distinct empty state so users know to wait for indexing rather
  // than lower the threshold.
  let embeddingsUnavailable = $state<boolean>(false);
  // #237 — 1.0 = clustering off; any lower value collapses notes whose
  // pairwise cosine similarity clears this threshold. Two values: the
  // instant slider reading (shown on the UI) and the debounced applied
  // value (fed into the render pipeline). Separating them keeps the
  // thumb responsive while avoiding per-mousemove sim rebuilds.
  let embeddingClusterThreshold = $state<number>(CLUSTER_THRESHOLD_DEFAULT);
  let embeddingClusterThresholdApplied = $state<number>(CLUSTER_THRESHOLD_DEFAULT);
  let clusterTimer: ReturnType<typeof setTimeout> | null = null;

  // #257 — visibility tracking. The graph tab is kept mounted (hidden via
  // style:display=none, see EditorPane.svelte) when not the active tab in
  // its pane. Without tracking visibility, the d3-force simulation + sigma
  // render loop keep ticking in the background — 5–15% CPU continuously
  // while the user is typing in another tab. We pause on hide, resume on
  // show, and defer any pending refetch triggered while hidden.
  let rootEl = $state<HTMLDivElement | undefined>();
  let isVisible = $state<boolean>(true);
  let pendingRefetchWhileHidden = $state<boolean>(false);
  let intersectionObserver: IntersectionObserver | null = null;

  let unlistenFileChange: UnlistenFn | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  const REFETCH_DEBOUNCE_MS = 300;
  // Threshold-slider drag → debounce IPC re-queries so dragging doesn't
  // spam the backend. 200ms is the smallest debounce that feels
  // responsive while still coalescing typical drag traffic.
  const THRESHOLD_DEBOUNCE_MS = 200;
  let thresholdTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic request id — only the latest in-flight refetch is allowed
  // to commit its response to `data`. Without this, a slow link-graph
  // load racing a fast embedding-graph swap would overwrite the newer
  // result with the stale one.
  let inflightRequestId = 0;

  const unsubVault = vaultStore.subscribe((s) => {
    if (s.currentPath !== vaultPath) {
      vaultPath = s.currentPath;
      if (vaultPath) {
        filters = loadFilters(vaultPath);
        frozen = loadFrozen(vaultPath);
        // #288 — load mode first so force defaults can match the active
        // graph type (link vs embedding have very different tunings).
        mode = loadMode(vaultPath);
        forces = loadForces(vaultPath, mode);
        embeddingThreshold = loadThreshold(vaultPath);
        const loadedCluster = loadClusterThreshold(vaultPath);
        embeddingClusterThreshold = loadedCluster;
        embeddingClusterThresholdApplied = loadedCluster;
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

  // Cluster slider's effective lower bound — clamped to the edge threshold
  // so the user never gets a slider range that can't cluster anything
  // (edges below `embeddingThreshold` are filtered out backend-side and
  // therefore never union a cluster; with cluster_threshold < edge_threshold
  // every surviving edge would collapse into a single mega-cluster).
  const clusterThresholdMin = $derived.by<number>(() => {
    return Math.max(CLUSTER_THRESHOLD_ABS_MIN, embeddingThreshold);
  });

  // Effective cluster threshold feeding the render pipeline. Uses the
  // debounced `Applied` value and clamps it to the current edge threshold
  // so a below-edge cluster_threshold doesn't accidentally collapse every
  // surviving edge into a mega-cluster.
  const effectiveClusterThreshold = $derived.by<number>(() => {
    return Math.max(clusterThresholdMin, embeddingClusterThresholdApplied);
  });

  // #237 — clustered view handed to GraphCanvas. In link mode or when the
  // slider is at the off position this is a reference passthrough so the
  // canvas-side memo/equality checks don't see a new object per tick.
  const renderedData = $derived.by<LocalGraph | null>(() => {
    if (!data) return null;
    if (mode !== "embedding") return data;
    if (effectiveClusterThreshold >= CLUSTER_THRESHOLD_MAX) return data;
    return clusterGraph(data, effectiveClusterThreshold).graph;
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
      embeddingsUnavailable = false;
      return;
    }
    inflightRequestId += 1;
    const requestId = inflightRequestId;
    loading = true;
    errorMessage = null;
    const currentMode = mode;
    const currentThreshold = embeddingThreshold;
    try {
      const result =
        currentMode === "embedding"
          ? await getEmbeddingGraph(EMBEDDING_TOP_K, currentThreshold)
          : await getLinkGraph();
      // Stale-response guard: a newer refetch superseded this one.
      if (requestId !== inflightRequestId) return;
      data = result;
      // In embedding mode, an empty-node payload is the backend's
      // signal that embeddings aren't ready (sink missing, vault not
      // open for embeddings yet, etc.). Link mode hits the same empty
      // state only for truly empty vaults, which has its own message.
      embeddingsUnavailable =
        currentMode === "embedding" && result.nodes.length === 0;
    } catch (err) {
      if (requestId !== inflightRequestId) return;
      errorMessage =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Graph konnte nicht geladen werden.";
      data = { nodes: [], edges: [] };
      embeddingsUnavailable = false;
    } finally {
      if (requestId === inflightRequestId) loading = false;
    }
  }

  function onModeChange(next: GraphMode): void {
    if (next === mode) return;
    // #288 — forces persist per mode. Flush the current mode's settings
    // before switching so user tweaks on the link graph don't get
    // clobbered by loading the embedding slot, then load the new mode's
    // slot (falling back to its mode-appropriate defaults).
    if (vaultPath) saveForces(vaultPath, mode, forces);
    mode = next;
    if (vaultPath) {
      saveMode(vaultPath, next);
      forces = loadForces(vaultPath, next);
    }
    // Full dataset swap — force a layout re-seed so nodes don't animate
    // from link-graph positions into embedding-graph positions.
    datasetVersion += 1;
    scheduleRefetch();
  }

  function onThresholdChange(next: number): void {
    const clamped = Math.min(
      EMBEDDING_THRESHOLD_MAX,
      Math.max(EMBEDDING_THRESHOLD_MIN, next),
    );
    embeddingThreshold = clamped;
    if (vaultPath) saveThreshold(vaultPath, clamped);
    if (thresholdTimer) clearTimeout(thresholdTimer);
    thresholdTimer = setTimeout(() => {
      thresholdTimer = null;
      void refetch();
    }, THRESHOLD_DEBOUNCE_MS);
  }

  function onClusterChange(next: number): void {
    const clamped = Math.min(
      CLUSTER_THRESHOLD_MAX,
      Math.max(CLUSTER_THRESHOLD_ABS_MIN, next),
    );
    embeddingClusterThreshold = clamped;
    if (vaultPath) saveClusterThreshold(vaultPath, clamped);
    // Debounce the render-feeding `Applied` value so rapid slider drags
    // don't rebuild the force simulation on every mousemove. Clustering
    // itself is a pure O(N+E) pass — the expensive downstream work is
    // sigma + d3-force reacting to a new node/edge set.
    if (clusterTimer) clearTimeout(clusterTimer);
    clusterTimer = setTimeout(() => {
      clusterTimer = null;
      embeddingClusterThresholdApplied = clamped;
    }, CLUSTER_DEBOUNCE_MS);
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
    if (vaultPath) saveForces(vaultPath, mode, next);
  }

  function onFrozenChange(next: boolean): void {
    frozen = next;
    if (vaultPath) saveFrozen(vaultPath, next);
  }

  // #257 — combined freeze state fed to the canvas.
  //   - user-frozen (pin-button in the forces panel), OR
  //   - graph tab not visible on screen (pauses d3-force + sigma render).
  // GraphCanvas treats this as a single boolean and calls
  // setLayoutFrozen(handle, effectivelyFrozen) — stopping the simulation
  // when true and re-heating it at alpha=0.3 when false, all without
  // touching the simulation object identity (positions survive).
  const effectivelyFrozen = $derived.by<boolean>(() => {
    return frozen || !isVisible;
  });

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
        // Hidden → defer; visible → debounce.
        if (!isVisible) {
          pendingRefetchWhileHidden = true;
          return;
        }
        scheduleRefetch();
      }
    });

    // #257 — IntersectionObserver handles every "hidden" case uniformly:
    // tab not active (display:none collapses clientRect to 0), sidebar
    // rearrangement moving the pane off-screen, app minimized, etc.
    // rootMargin 0 with threshold 0 = "any pixel on screen counts as
    // visible", which is what we want (we only need the d3-force ticks
    // to pay their cost when the graph could actually be seen).
    if (rootEl && typeof IntersectionObserver !== "undefined") {
      intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          isVisible = entry.isIntersecting;
        }
      });
      intersectionObserver.observe(rootEl);
    }
  });

  // #257 — catch up on deferred refetches once the tab becomes visible.
  // A single scheduled refetch covers any number of file-change /
  // tab-save events that accumulated while hidden.
  $effect(() => {
    if (isVisible && pendingRefetchWhileHidden) {
      pendingRefetchWhileHidden = false;
      scheduleRefetch();
    }
  });

  // #257 — narrow, cheap content-change detection.
  //
  // tabStore emits on every per-keystroke setDirty, cursor move, scroll
  // update, and hash write. The previous implementation iterated every
  // tab and string-compared lastSavedContent on every emission — O(tabs *
  // content-size) per keystroke, on the editor hot path, even when the
  // graph tab wasn't visible. Swap that for a stable scalar signature
  // (`id:lastSaved`) that only changes when a tab actually saves. First
  // emission just seeds the baseline so we don't trigger a redundant
  // refetch on mount (the onMount below already kicks off the initial
  // load).
  let lastTabContentSig: string | null = null;
  const unsubTabsContent = tabStore.subscribe((s) => {
    const sig = tabContentSignature(s.tabs);
    if (lastTabContentSig === null) {
      lastTabContentSig = sig;
      return;
    }
    if (sig === lastTabContentSig) return;
    lastTabContentSig = sig;
    // If the graph tab is hidden, defer the refetch — mark as dirty and
    // catch up when the tab becomes visible again.
    if (!isVisible) {
      pendingRefetchWhileHidden = true;
      return;
    }
    scheduleRefetch();
  });

  onDestroy(() => {
    unsubVault();
    unsubTabs();
    unsubTabsContent();
    unlistenFileChange?.();
    if (refetchTimer) clearTimeout(refetchTimer);
    if (thresholdTimer) clearTimeout(thresholdTimer);
    if (clusterTimer) clearTimeout(clusterTimer);
    intersectionObserver?.disconnect();
    intersectionObserver = null;
  });
</script>

<svelte:document onkeydown={handleKeydown} />

<div class="vc-graph-view" role="region" aria-label="Graph-Ansicht" bind:this={rootEl}>
  <div class="vc-graph-mode-toolbar" role="group" aria-label="Graph-Modus">
    <div class="vc-graph-mode-pills">
      <button
        type="button"
        class="vc-graph-mode-pill"
        class:vc-graph-mode-pill--active={mode === "link"}
        onclick={() => onModeChange("link")}
        aria-pressed={mode === "link"}
        title="Link-basierter Graph (Wiki-Links)"
      >Links</button>
      <button
        type="button"
        class="vc-graph-mode-pill"
        class:vc-graph-mode-pill--active={mode === "embedding"}
        onclick={() => onModeChange("embedding")}
        aria-pressed={mode === "embedding"}
        title="Semantischer Graph (Embedding-Ähnlichkeit)"
      >Semantisch</button>
    </div>
    {#if mode === "embedding"}
      <label class="vc-graph-threshold">
        <span class="vc-graph-threshold-label">Schwellwert</span>
        <input
          type="range"
          min={EMBEDDING_THRESHOLD_MIN}
          max={EMBEDDING_THRESHOLD_MAX}
          step={EMBEDDING_THRESHOLD_STEP}
          value={embeddingThreshold}
          oninput={(e) =>
            onThresholdChange(Number((e.target as HTMLInputElement).value))}
          aria-label="Cosine-Schwellwert"
        />
        <span class="vc-graph-threshold-value">{embeddingThreshold.toFixed(2)}</span>
      </label>
      <label class="vc-graph-threshold" title="Fasst ähnliche Notizen zu einem Oberbegriff zusammen. Rechts (1.00) = aus.">
        <span class="vc-graph-threshold-label">Cluster</span>
        <input
          type="range"
          min={clusterThresholdMin}
          max={CLUSTER_THRESHOLD_MAX}
          step={CLUSTER_THRESHOLD_STEP}
          value={Math.max(clusterThresholdMin, embeddingClusterThreshold)}
          oninput={(e) =>
            onClusterChange(Number((e.target as HTMLInputElement).value))}
          aria-label="Cluster-Schwellwert"
        />
        <span class="vc-graph-threshold-value">
          {embeddingClusterThreshold >= CLUSTER_THRESHOLD_MAX
            ? "aus"
            : Math.max(clusterThresholdMin, embeddingClusterThreshold).toFixed(2)}
        </span>
      </label>
    {/if}
  </div>
  {#if errorMessage}
    <div class="vc-graph-empty">{errorMessage}</div>
  {:else if !data || data.nodes.length === 0}
    <div class="vc-graph-empty">
      {#if loading}
        Graph wird geladen...
      {:else if mode === "embedding" && embeddingsUnavailable}
        Semantischer Graph nicht verfügbar — Embeddings sind noch nicht erstellt.
      {:else}
        Keine Notizen im Vault.
      {/if}
    </div>
  {:else}
    <GraphCanvas
      data={renderedData}
      activeId={activeRelPath}
      {savedCamera}
      dimForNode={(id) => dimForNode(id)}
      onNodeClick={onNodeClick}
      {onCameraChange}
      datasetVersion={datasetVersion}
      forceSettings={forces}
      frozen={effectivelyFrozen}
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
  .vc-graph-mode-toolbar {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 11;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 8px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }
  .vc-graph-mode-pills {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    overflow: hidden;
  }
  .vc-graph-mode-pill {
    padding: 4px 10px;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .vc-graph-mode-pill + .vc-graph-mode-pill {
    border-left: 1px solid var(--color-border);
  }
  .vc-graph-mode-pill:hover {
    color: var(--color-accent);
  }
  .vc-graph-mode-pill--active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }
  .vc-graph-threshold {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .vc-graph-threshold-label {
    user-select: none;
  }
  .vc-graph-threshold input[type="range"] {
    width: 110px;
    accent-color: var(--color-accent);
  }
  .vc-graph-threshold-value {
    width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
</style>
