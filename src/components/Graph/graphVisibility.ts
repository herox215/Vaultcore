// #257 — narrow tabStore subscription helper for GraphView.
//
// Background: `GraphView.svelte` used to diff `lastSavedContent` across
// every tab on every `tabStore` emission to decide whether to schedule a
// graph refetch. Because `tabStore` emits on per-keystroke `setDirty` and
// on scroll-position updates, that subscriber ran O(tabs) string-compares
// on the editor hot path — even when the graph tab wasn't visible.
//
// The only signal GraphView actually needs is "did some tab's saved
// content change?". Saves bump both `lastSaved` (timestamp, scalar) and
// the base `lastSavedContent` (potentially a large string). Building a
// signature from the cheap scalar (`id:lastSaved`) gives us a stable key
// that changes only on actual saves, not on every keystroke.
//
// Graph tabs are excluded — they never hold note content.

export interface TabSaveInfo {
  id: string;
  type?: "file" | "graph";
  lastSaved: number;
}

/**
 * Cheap signature of the "something saved" state across file tabs.
 * Graph tabs are ignored. Order-stable for a given tabs array (we walk
 * the input without sorting — callers pass `state.tabs` which is itself
 * order-stable per tabStore contract).
 *
 * Output is a joined string — comparable with === and cheap to recompute
 * on every tabStore emission. Storing it as a module-local `string`
 * lets subscribers short-circuit the common case where the emission is
 * an unrelated per-tab field flip (isDirty, scrollPos, lastSavedHash).
 */
export function tabContentSignature(
  tabs: ReadonlyArray<TabSaveInfo>,
): string {
  const parts: string[] = [];
  for (const t of tabs) {
    if (t.type === "graph") continue;
    parts.push(`${t.id}:${t.lastSaved}`);
  }
  return parts.join("|");
}
