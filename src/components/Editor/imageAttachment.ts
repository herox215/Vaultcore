// Image paste and drop handler for the CodeMirror 6 editor.
// Saves images to the vault's attachment folder and inserts markdown references.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { get } from "svelte/store";
import { settingsStore, ATTACHMENT_FOLDER_DEFAULT } from "../../store/settingsStore";
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

function getAttachmentFolder(): string {
  const s = get(settingsStore);
  return s.attachmentFolder || ATTACHMENT_FOLDER_DEFAULT;
}

async function handleSave(view: EditorView, blob: Blob, filename: string): Promise<void> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const folder = getAttachmentFolder();
    const relPath = await saveAttachment(folder, filename, bytes);
    // URL-encode path but preserve slashes (encodeURI, not encodeURIComponent)
    const encoded = encodeURI(relPath);
    const md = `![](${encoded})`;
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: head, insert: md },
      selection: { anchor: head + md.length },
    });
    view.focus();
  } catch (err) {
    console.error("[imageAttachment] save failed:", err);
  }
}

async function handleSaveMany(view: EditorView, files: File[]): Promise<void> {
  const folder = getAttachmentFolder();
  const parts: string[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Strip any path prefix (some browsers include full path in name)
      const basename = file.name.replace(/.*[/\\]/, "");
      const relPath = await saveAttachment(folder, basename, bytes);
      const encoded = encodeURI(relPath);
      parts.push(`![](${encoded})`);
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

      void handleSave(view, blob, filename);
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
