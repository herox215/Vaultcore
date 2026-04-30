// Per-tabId snapshot registry for canvas tab-morph (#383).
//
// `CanvasView.svelte` instances register a closure that produces a
// `ViewSnapshot` for their current state on mount, and unregister on
// destroy. `EditorPane.svelte` looks up the snapshot fn by tabId both
// when capturing the OUTGOING snapshot (synchronously, before Svelte
// flips display) and the INCOMING snapshot (inside rAF, after the
// new container has been laid out).
//
// Module-level singleton, deliberately not `$state` — this is a pure
// lookup table, not a reactive surface. `tabId`s are UUIDs so cross-pane
// collisions are impossible by construction; if the codebase ever moves
// to per-pane id namespaces, this map would need to become per-pane too.
//
// Pattern mirrors the `viewMap` non-reactive Map in `EditorPane.svelte`
// — wrapping DOM/closure refs in `$state` triggers Svelte 5 proxy
// behavior that breaks identity-sensitive consumers.

import type { ViewSnapshot } from "../morphTypes";

const registry = new Map<string, () => ViewSnapshot | null>();

export function registerCanvasSnapshot(
  tabId: string,
  fn: () => ViewSnapshot | null,
): void {
  registry.set(tabId, fn);
}

export function unregisterCanvasSnapshot(tabId: string): void {
  registry.delete(tabId);
}

/**
 * Look up and invoke the snapshot fn for a tab, returning `null` if the
 * tab isn't a canvas (or hasn't registered yet — e.g. mount race during
 * a chord cycle through a freshly opened tab).
 */
export function snapshotCanvasTab(tabId: string): ViewSnapshot | null {
  const fn = registry.get(tabId);
  return fn ? fn() : null;
}
