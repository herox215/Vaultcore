// Substitute `{{...}}` template tokens in a string.
//
// Legacy tokens (kept verbatim for back-compat with existing templates):
//   {{date}}   → YYYY-MM-DD
//   {{time}}   → HH:mm
//   {{title}}  → active note title (filename without .md)
//
// Expression tokens (#283):
//   Any other `{{ expr }}` body is parsed and evaluated against the vault
//   API root when one is provided. Evaluation errors are rendered inline as
//   `{{!err: ...}}` so the user can debug without breaking the surrounding
//   template. When no vault root is given, unknown tokens are left literal —
//   preserves the old behaviour where `{{author}}` round-trips unchanged.

import { evaluate, ExprError, renderValue } from "./templateExpression";
import type { VaultRoot } from "./vaultApi";

export interface SubstituteOptions {
  vaultRoot?: VaultRoot;
}

const EXPR_RE = /\{\{([^{}]+?)\}\}/g;

export function substituteTemplateVars(
  content: string,
  title: string,
  options: SubstituteOptions = {},
): string {
  const now = new Date();

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const date = `${yyyy}-${mm}-${dd}`;

  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const time = `${hh}:${min}`;

  return content.replace(EXPR_RE, (full, raw: string) => {
    const body = raw.trim();
    if (body === "date") return date;
    if (body === "time") return time;
    if (body === "title") return title;
    if (!options.vaultRoot) return full;
    try {
      const value = evaluate(body, { vault: options.vaultRoot });
      return renderValue(value);
    } catch (e) {
      const msg = e instanceof ExprError ? e.message : String(e);
      return `{{!err: ${msg}}}`;
    }
  });
}
