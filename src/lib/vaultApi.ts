// Vault expression API — the root object `{{vault...}}` expressions resolve
// against. Shape is deliberately minimal for the MVP (#283): `vault.name`,
// `vault.path`, `vault.notes`, `vault.tags`, `vault.bookmarks`, `vault.folders`,
// `vault.stats`.
//
// Design:
//   - Every field is a getter so we read stores lazily at access time —
//     downstream `Collection` ops never force unrelated stores.
//   - Each custom type attaches `__typeName` + (where meaningful) `__id` so
//     `renderValue()` can emit debug-friendly strings without per-type hooks.
//   - `note.property` uses a Proxy restricted to actual frontmatter keys so
//     enumeration reflects the note's real shape (allows the completion
//     provider to discover keys).
//   - Stores are injected (`VaultStores`) so the module stays testable with
//     plain objects — no implicit svelte/store import at runtime.

import { Collection } from "./queryCollection";
import { parseFrontmatter } from "./frontmatterIO";
import type { Property } from "./frontmatterIO";

export interface VaultStoreSnapshot {
  name: string;
  path: string;
  fileList: string[];
}

export interface TagSnapshot {
  tag: string;
  count: number;
}

export interface VaultStores {
  readVault: () => VaultStoreSnapshot;
  readTags: () => TagSnapshot[];
  readBookmarks: () => string[];
  /** Read the full markdown text of a note, vault-relative path. */
  readNoteContent?: (relPath: string) => string | null;
}

// --- Public types ---

export interface Note {
  readonly __typeName: "Note";
  readonly __id: string;
  readonly name: string;
  readonly path: string;
  readonly title: string;
  readonly property: Record<string, string | string[]>;
  readonly content: string;
}

export interface Folder {
  readonly __typeName: "Folder";
  readonly __id: string;
  readonly name: string;
  readonly path: string;
}

export interface Tag {
  readonly __typeName: "Tag";
  readonly __id: string;
  readonly name: string;
  readonly count: number;
}

export interface VaultRoot {
  readonly __typeName: "Vault";
  readonly name: string;
  readonly path: string;
  readonly notes: Collection<Note>;
  readonly folders: Collection<Folder>;
  readonly tags: Collection<Tag>;
  readonly bookmarks: Collection<Note>;
  readonly stats: {
    readonly __typeName: "VaultStats";
    readonly noteCount: number;
    readonly tagCount: number;
  };
}

// --- Factory ---

export function createVaultRoot(stores: VaultStores): VaultRoot {
  const noteCache = new Map<string, Note>();

  const buildNote = (relPath: string): Note => {
    const cached = noteCache.get(relPath);
    if (cached) return cached;
    const note = makeNote(relPath, stores, noteCache);
    noteCache.set(relPath, note);
    return note;
  };

  const root: VaultRoot = Object.defineProperties({} as VaultRoot, {
    __typeName: { value: "Vault", enumerable: true },
    name: {
      enumerable: true,
      get: () => stores.readVault().name,
    },
    path: {
      enumerable: true,
      get: () => stores.readVault().path,
    },
    notes: {
      enumerable: true,
      get: () => {
        const paths = stores.readVault().fileList;
        return new Collection<Note>(paths.map(buildNote));
      },
    },
    folders: {
      enumerable: true,
      get: () => {
        const paths = stores.readVault().fileList;
        const folders = collectFolders(paths);
        return new Collection<Folder>(folders);
      },
    },
    tags: {
      enumerable: true,
      get: () => {
        const tags = stores.readTags();
        return new Collection<Tag>(tags.map(makeTag));
      },
    },
    bookmarks: {
      enumerable: true,
      get: () => {
        const paths = stores.readBookmarks();
        return new Collection<Note>(paths.map(buildNote));
      },
    },
    stats: {
      enumerable: true,
      get: () => ({
        __typeName: "VaultStats" as const,
        noteCount: stores.readVault().fileList.length,
        tagCount: stores.readTags().length,
      }),
    },
  });

  return root;
}

// --- Internals ---

function makeNote(
  relPath: string,
  stores: VaultStores,
  _cache: Map<string, Note>,
): Note {
  const name = basename(relPath);
  const title = stripMdExt(name);
  // Content and frontmatter are lazy-read: most expressions only touch
  // name/path and never need the content.
  let contentMemo: string | null | undefined = undefined;
  const getContent = (): string => {
    if (contentMemo === undefined) {
      contentMemo = stores.readNoteContent?.(relPath) ?? null;
    }
    return contentMemo ?? "";
  };

  let propsMemo: Property[] | undefined = undefined;
  const getProps = (): Property[] => {
    if (propsMemo === undefined) {
      const content = getContent();
      propsMemo = content ? parseFrontmatter(content).properties : [];
    }
    return propsMemo;
  };

  const propertyProxy = new Proxy({} as Record<string, string | string[]>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      // Keep common internal markers queryable for rendering but hide prototype.
      if (key === "__typeName") return "NoteProperties";
      const prop = getProps().find((p) => p.key === key);
      if (!prop) return undefined;
      if (prop.listStyle) return prop.values;
      return prop.values[0] ?? "";
    },
    has(_target, key) {
      if (typeof key !== "string") return false;
      return getProps().some((p) => p.key === key);
    },
    ownKeys() {
      return getProps().map((p) => p.key);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== "string") return undefined;
      if (!getProps().some((p) => p.key === key)) return undefined;
      return { enumerable: true, configurable: true };
    },
    set() { return false; },
    deleteProperty() { return false; },
  });

  const note: Note = Object.defineProperties({} as Note, {
    __typeName: { value: "Note", enumerable: true },
    __id: { value: relPath, enumerable: true },
    name: { value: name, enumerable: true },
    path: { value: relPath, enumerable: true },
    title: { value: title, enumerable: true },
    property: { value: propertyProxy, enumerable: true },
    content: { enumerable: true, get: getContent },
  });

  return note;
}

function collectFolders(paths: string[]): Folder[] {
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folderPath = parts.slice(0, i).join("/");
      if (seen.has(folderPath)) continue;
      seen.add(folderPath);
      out.push({
        __typeName: "Folder",
        __id: folderPath,
        name: parts[i - 1]!,
        path: folderPath,
      });
    }
  }
  return out;
}

function makeTag(t: TagSnapshot): Tag {
  return {
    __typeName: "Tag",
    __id: t.tag,
    name: t.tag,
    count: t.count,
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function stripMdExt(n: string): string {
  return n.endsWith(".md") ? n.slice(0, -3) : n;
}
