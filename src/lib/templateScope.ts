// Shared scope construction for `{{ ... }}` template expressions (#321).
//
// The CM6 live-preview plugin (`templateLivePreview.ts`) and the Reading Mode
// renderer (`reading/markdownRenderer.ts`) must expose the same identifiers
// to user expressions, otherwise a template that works while editing would
// render differently once the tab flips to Reading Mode. This module owns
// the one source of truth for that scope shape.

import { get } from "svelte/store";

import type { EvalScope } from "./templateExpression";
import { currentVaultRoot } from "./vaultApiStoreBridge";
import { editorStore } from "../store/editorStore";

export function formatDate(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatTime(now: Date): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mi}`;
}

/**
 * Derive the bare note name (no extension, no directory) from a vault-relative
 * path. Used as the `title` binding when no override is provided. `""` when
 * the path is empty or has no basename.
 */
export function titleFromPath(path: string | null | undefined): string {
  if (!path) return "";
  const name = path.split("/").pop() ?? "";
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function activeTitle(): string {
  return titleFromPath(get(editorStore).activePath);
}

/**
 * Build the `EvalScope` exposed to `{{ ... }}` expressions.
 *
 * `title` may be passed explicitly (Reading Mode knows the tab's file path up
 * front); when omitted, it falls back to the active editor tab's basename —
 * the CM6 plugin's behaviour.
 */
export function buildTemplateScope(options?: {
  now?: Date;
  title?: string;
}): EvalScope {
  const now = options?.now ?? new Date();
  const title = options?.title ?? activeTitle();
  return {
    vault: currentVaultRoot(),
    date: formatDate(now),
    time: formatTime(now),
    title,
  };
}
