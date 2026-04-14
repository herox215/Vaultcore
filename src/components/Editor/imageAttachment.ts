// Image paste and drop handler for the CodeMirror 6 editor.
// Saves images next to the active note's .md file and inserts `![[name.ext]]`
// wiki-embed references. Works together with embedPlugin.ts for inline rendering.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { get } from "svelte/store";
import { tabStore } from "../../store/tabStore";
import { vaultStore } from "../../store/vaultStore";
import { saveAttachment } from "../../ipc/commands";

function extFromMime(mime: string): string | null {
  switch (mime) {
    case "image/png":  return "png";
    case "image/jpeg": return "jpg";
    case "image/gif":  return "gif";
    case "image/webp": return "webp";
    default:           return null;
  }
}

function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Return the vault-relative directory of the currently-active tab's file,
 * e.g. `"foo/bar"` for `/vault/foo/bar/note.md`, or `""` for a file at the
 * vault root or when no tab is active. Uses forward slashes regardless of
 * the host OS so it matches the save_attachment IPC's expectation.
 */
function getActiveNoteDir(): string {
  const vault = get(vaultStore).currentPath;
  if (!vault) return "";
  const tabs = get(tabStore);
  if (!tabs.activeTabId) return "";
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId);
  if (!activeTab) return "";

  const abs = activeTab.filePath;
  // Normalize to forward slashes so the prefix strip and `lastIndexOf("/")`
  // below are consistent across Windows and Unix.
  const absFwd = abs.replace(/\\/g, "/");
  const vaultFwd = vault.replace(/\\/g, "/").replace(/\/$/, "");
  if (!absFwd.startsWith(vaultFwd + "/")) return "";
  const rel = absFwd.slice(vaultFwd.length + 1);
  const lastSlash = rel.lastIndexOf("/");
  return lastSlash === -1 ? "" : rel.slice(0, lastSlash);
}

/**
 * Format a vault-relative attachment path as a wiki-embed reference.
 * Uses just the basename — the embed resolver looks up by filename.
 */
export function formatEmbedReference(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  const basename = idx === -1 ? relPath : relPath.slice(idx + 1);
  return `![[${basename}]]`;
}

async function handleSave(view: EditorView, blob: Blob, filename: string, userEvent: string): Promise<void> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const folder = getActiveNoteDir();
    const relPath = await saveAttachment(folder, filename, bytes);
    const md = formatEmbedReference(relPath);
    const head = view.state.selection.main.head;
    // The userEvent annotation lets the frontmatter boundary guard
    // transactionFilter redirect inserts that land inside the frontmatter
    // region (e.g. head === 0 because the drop missed any text target).
    view.dispatch({
      changes: { from: head, insert: md },
      selection: { anchor: head + md.length },
      userEvent,
    });
    view.focus();
  } catch (err) {
    console.error("[imageAttachment] save failed:", err);
  }
}

async function handleSaveMany(view: EditorView, files: File[]): Promise<void> {
  const folder = getActiveNoteDir();
  const parts: string[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Strip any path prefix (some browsers include full path in name)
      const basename = file.name.replace(/.*[/\\]/, "");
      const relPath = await saveAttachment(folder, basename, bytes);
      parts.push(formatEmbedReference(relPath));
    } catch (err) {
      console.error("[imageAttachment] drop save failed:", err);
    }
  }
  if (parts.length === 0) return;

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const atLineStart = head === line.from;

  let insert: string;
  if (atLineStart) {
    insert = parts.join("\n") + "\n";
  } else {
    insert = "\n" + parts.join("\n") + "\n";
  }

  view.dispatch({
    changes: { from: head, insert },
    selection: { anchor: head + insert.length },
    userEvent: "input.drop",
  });
  view.focus();
}

function hasFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes("Files");
}

export function imageAttachmentExtension(): Extension {
  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView): boolean {
      const items = event.clipboardData?.items;
      if (!items) return false;

      let imageItem: DataTransferItem | null = null;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) return false;

      event.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) return false;

      const ext = extFromMime(blob.type) ?? "png";
      const ts = nowTimestamp();
      const filename = `Pasted image ${ts}.${ext}`;

      void handleSave(view, blob, filename, "input.paste");
      return true;
    },

    // The browser only fires `drop` on a target whose `dragover` had its
    // default prevented — otherwise the OS treats it as "copy not allowed"
    // and the drop never happens.
    dragover(event: DragEvent): boolean {
      if (!hasFileDrag(event.dataTransfer)) return false;
      event.preventDefault();
      return true;
    },

    drop(event: DragEvent, view: EditorView): boolean {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return false;

      event.preventDefault();
      void handleSaveMany(view, images);
      return true;
    },
  });
}
