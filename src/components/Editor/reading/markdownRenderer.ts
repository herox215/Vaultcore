// Markdown renderer for Reading Mode (#63).
//
// Uses markdown-it for the core markdown->HTML pass plus two custom inline
// rules so the reader matches the editor's link model:
//   - `![[target]]` / `![[target|size]]` — wiki-embeds, rendered as <img>
//     against the Tauri asset:// protocol via convertFileSrc() when the
//     attachment resolves, otherwise as an unresolved note-embed block.
//   - `[[target]]` / `[[target|alias]]` — wiki-links, rendered as anchors
//     carrying data-wiki-target / data-wiki-resolved attributes so the
//     Svelte click handler can reuse the existing resolve path.
//
// Raw HTML is disabled (markdown-it's `html: false`) and the final string is
// sanitised with DOMPurify before it reaches the DOM, so user-authored
// <script>/<iframe>/onerror= payloads cannot execute.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { get } from "svelte/store";

import { resolveTarget } from "../wikiLink";
import { resolveAttachment } from "../embeds";
import { vaultStore } from "../../../store/vaultStore";

/**
 * Single shared instance — markdown-it is stateless between render() calls so
 * module-level reuse is safe and keeps the plugin-registration cost out of
 * the hot path.
 */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
});

// ── Wiki-embed inline rule (`![[target]]`) ────────────────────────────────────

md.inline.ruler.before("emphasis", "wiki_embed", (state: StateInline, silent: boolean) => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x21 /* ! */) return false;
  if (src.charCodeAt(start + 1) !== 0x5b /* [ */) return false;
  if (src.charCodeAt(start + 2) !== 0x5b /* [ */) return false;

  const closeIdx = src.indexOf("]]", start + 3);
  if (closeIdx === -1) return false;

  const inner = src.slice(start + 3, closeIdx);
  if (inner.includes("\n")) return false;

  if (!silent) {
    // Split off optional |sizing and #heading segments.
    let target = inner;
    let sizing: string | null = null;
    const pipeIdx = target.indexOf("|");
    if (pipeIdx !== -1) {
      sizing = target.slice(pipeIdx + 1).trim();
      target = target.slice(0, pipeIdx);
    }
    const hashIdx = target.indexOf("#");
    if (hashIdx !== -1) {
      target = target.slice(0, hashIdx);
    }
    target = target.trim();

    const token = state.push("wiki_embed", "", 0);
    token.meta = { target, sizing };
    token.content = inner;
  }

  state.pos = closeIdx + 2;
  return true;
});

// ── Wiki-link inline rule (`[[target]]` / `[[target|alias]]`) ─────────────────

md.inline.ruler.before("emphasis", "wiki_link", (state: StateInline, silent: boolean) => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b /* [ */) return false;
  if (src.charCodeAt(start + 1) !== 0x5b /* [ */) return false;

  const closeIdx = src.indexOf("]]", start + 2);
  if (closeIdx === -1) return false;

  const inner = src.slice(start + 2, closeIdx);
  if (inner.includes("\n") || inner.length === 0) return false;

  if (!silent) {
    let target = inner;
    let alias: string | null = null;
    const pipeIdx = target.indexOf("|");
    if (pipeIdx !== -1) {
      alias = target.slice(pipeIdx + 1).trim();
      target = target.slice(0, pipeIdx);
    }
    const hashIdx = target.indexOf("#");
    if (hashIdx !== -1) {
      target = target.slice(0, hashIdx);
    }
    target = target.trim();

    const token = state.push("wiki_link", "", 0);
    token.meta = { target, alias };
    token.content = inner;
  }

  state.pos = closeIdx + 2;
  return true;
});

// ── Token renderers ──────────────────────────────────────────────────────────

md.renderer.rules["wiki_embed"] = (tokens, idx) => {
  const token = tokens[idx];
  if (!token || !token.meta) return "";
  const { target, sizing } = token.meta as { target: string; sizing: string | null };
  const attachmentRel = resolveAttachment(target);
  const escapedLabel = md.utils.escapeHtml(target);

  if (attachmentRel === null) {
    // Treat unresolved embeds as note-embed placeholders — same shape the
    // editor plugin uses for unknown notes.
    return `<span class="vc-reading-embed vc-reading-embed--unresolved" data-embed-target="${escapedLabel}">${escapedLabel}</span>`;
  }

  // resolveAttachment() returns a vault-relative path — convertFileSrc needs
  // an absolute filesystem path, so prepend the current vault root.
  const vault = get(vaultStore).currentPath;
  if (!vault) return `<span class="vc-reading-embed vc-reading-embed--unresolved">${escapedLabel}</span>`;
  const absPath = `${vault.replace(/\\/g, "/").replace(/\/$/, "")}/${attachmentRel}`;
  const src = convertFileSrc(absPath);
  const widthAttr = sizing !== null && /^\d+$/.test(sizing) ? ` width="${sizing}"` : "";
  return `<img class="vc-reading-embed-img" src="${md.utils.escapeHtml(src)}" alt="${escapedLabel}"${widthAttr}>`;
};

md.renderer.rules["wiki_link"] = (tokens, idx) => {
  const token = tokens[idx];
  if (!token || !token.meta) return "";
  const { target, alias } = token.meta as { target: string; alias: string | null };
  const resolved = resolveTarget(target) !== null;
  const label = md.utils.escapeHtml(alias ?? target);
  const escapedTarget = md.utils.escapeHtml(target);
  const cls = resolved ? "vc-reading-wikilink vc-reading-wikilink--resolved" : "vc-reading-wikilink vc-reading-wikilink--unresolved";
  return `<a class="${cls}" href="#" data-wiki-target="${escapedTarget}" data-wiki-resolved="${resolved ? "true" : "false"}">${label}</a>`;
};

// Task list items — `- [ ]` / `- [x]` become disabled checkboxes. markdown-it
// emits them as literal text inside <li>, so a regex post-process is both
// simpler and more reliable than an inline rule override (which doesn't fire
// for the leading bracket because of the list-item indent handling).
const TASK_RE = /<li>(\s*)\[( |x|X)\]\s/g;
function renderTaskListCheckboxes(html: string): string {
  return html.replace(TASK_RE, (_match, ws: string, state: string) => {
    const checked = state.toLowerCase() === "x";
    return `<li class="vc-reading-task-item">${ws}<input type="checkbox" class="vc-reading-task" disabled${checked ? " checked" : ""}> `;
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a markdown string to sanitized HTML suitable for injection via
 * `innerHTML`. Wiki-links reuse the existing resolution map so click-through
 * can dispatch the same handler the editor uses.
 */
/**
 * Allow Tauri's `asset://` and the Tauri-Windows `http(s)://ipc.localhost`
 * convention that `convertFileSrc()` produces. Without this, DOMPurify strips
 * the `src` attribute on every <img> that embeds a vault attachment.
 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|ftp|mailto|tel|asset|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function renderMarkdownToHtml(markdown: string): string {
  // Strip YAML frontmatter — readers don't want to see --- blocks at the top
  // of every note. Same rule the editor frontmatter plugin applies.
  const stripped = stripFrontmatter(markdown);
  const rawHtml = renderTaskListCheckboxes(md.render(stripped));
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ["data-wiki-target", "data-wiki-resolved", "data-embed-target"],
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP,
  });
}

function stripFrontmatter(src: string): string {
  if (!src.startsWith("---")) return src;
  const rest = src.slice(3);
  // Accept --- followed by a newline (standard) or EOF
  if (rest.length > 0 && rest[0] !== "\n" && rest[0] !== "\r") return src;
  const closeIdx = rest.indexOf("\n---");
  if (closeIdx === -1) return src;
  // Slice past the closing ---\n
  const afterClose = closeIdx + 4;
  let tail = rest.slice(afterClose);
  if (tail.startsWith("\r")) tail = tail.slice(1);
  if (tail.startsWith("\n")) tail = tail.slice(1);
  return tail;
}
