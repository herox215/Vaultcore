// Per-vault home canvas helpers (#279).
// The home canvas lives at `<vault>/.vaultcore/home.canvas` — a regular
// canvas file, but stored inside the `.vaultcore/` state dir so the file
// walker, link graph, backlinks, and search all skip it via the existing
// dot-prefix rule. The Rust side (`ensure_home_canvas`) bootstraps the
// template on every vault open.

import { get } from "svelte/store";
import { vaultStore } from "../store/vaultStore";
import { openFileAsTab } from "./openFileAsTab";

/** Vault-relative path of the home canvas. */
export const HOME_CANVAS_REL = ".vaultcore/home.canvas";

/** Normalise path separators so comparisons work on Windows paths too. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Absolute path of the home canvas inside the given vault. */
export function homeCanvasPath(vaultPath: string): string {
  return `${norm(vaultPath)}/${HOME_CANVAS_REL}`;
}

/** True when `absPath` points at a vault's home canvas. */
export function isHomeCanvasPath(absPath: string): boolean {
  return norm(absPath).endsWith(`/${HOME_CANVAS_REL}`);
}

/** Derive the vault name to show on the home tab from its absolute path. */
export function homeTabLabel(absPath: string): string {
  const n = norm(absPath);
  const idx = n.lastIndexOf(`/${HOME_CANVAS_REL}`);
  if (idx <= 0) return "Home";
  const vaultSegment = n.slice(0, idx).split("/").pop();
  return vaultSegment && vaultSegment.length > 0 ? vaultSegment : "Home";
}

/**
 * Open (or focus) the current vault's home canvas. Singleton by path —
 * `openFileAsTab` routes to `tabStore.openFileTab` which dedupes on filePath.
 * No-op when no vault is open.
 */
export async function openHomeCanvas(): Promise<void> {
  const vaultPath = get(vaultStore).currentPath;
  if (!vaultPath) return;
  await openFileAsTab(homeCanvasPath(vaultPath));
}
