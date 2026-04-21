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
import { stripTemplateExpressions } from "./templateExprRegex";

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
  readonly notes: Collection<Note>;
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
        const folders = collectFolders(paths, buildNote);
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
  //
  // #325 — two memoized views on the raw text:
  //   - `getRawContent()` is used by frontmatter parsing, which must see
  //     the verbatim file (frontmatter keys could, in pathological cases,
  //     span or neighbour a `{{ ... }}` region, and YAML parsing needs the
  //     unmodified bytes).
  //   - `getStrippedContent()` is what user predicates see via the `.content`
  //     accessor below. It erases every `{{ ... }}` region so a template
  //     body literal like `.contains("todo")` inside its own expression does
  //     NOT make the host note match itself. Template bodies are code, not
  //     prose — they have no business showing up in content searches.
  // Memo coupling: `strippedContentMemo` is derived from `rawContentMemo`.
  // Neither is invalidated today (the note object is rebuilt on every vault
  // tick), but if a future refactor adds hot-reload for `.content`, BOTH
  // memos must be reset together — otherwise `.content` would return a
  // stripped view of stale bytes while frontmatter sees fresh raw bytes.
  let rawContentMemo: string | null | undefined = undefined;
  const getRawContent = (): string => {
    if (rawContentMemo === undefined) {
      rawContentMemo = stores.readNoteContent?.(relPath) ?? null;
    }
    return rawContentMemo ?? "";
  };
  let strippedContentMemo: string | undefined = undefined;
  const getStrippedContent = (): string => {
    if (strippedContentMemo === undefined) {
      strippedContentMemo = stripTemplateExpressions(getRawContent());
    }
    return strippedContentMemo;
  };

  let propsMemo: Property[] | undefined = undefined;
  const getProps = (): Property[] => {
    if (propsMemo === undefined) {
      const content = getRawContent();
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
    content: { enumerable: true, get: getStrippedContent },
  });

  return note;
}

function collectFolders(
  paths: readonly string[],
  buildNote: (relPath: string) => Note,
): Folder[] {
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folderPath = parts.slice(0, i).join("/");
      if (seen.has(folderPath)) continue;
      seen.add(folderPath);
      out.push(makeFolder(folderPath, parts[i - 1]!, paths, buildNote));
    }
  }
  return out;
}

// `notes` is a getter so the filter+map runs only when accessed — the common
// `{{vault.folders.select(f => f.name)}}` path never touches it. The captured
// `allPaths` is the snapshot taken at `vault.folders` access time, matching
// the folder list itself (one consistent view per expression evaluation).
function makeFolder(
  folderPath: string,
  name: string,
  allPaths: readonly string[],
  buildNote: (relPath: string) => Note,
): Folder {
  const prefix = folderPath + "/";
  return Object.defineProperties({} as Folder, {
    __typeName: { value: "Folder", enumerable: true },
    __id: { value: folderPath, enumerable: true },
    name: { value: name, enumerable: true },
    path: { value: folderPath, enumerable: true },
    notes: {
      enumerable: true,
      get: () =>
        new Collection<Note>(
          allPaths.filter((p) => p.startsWith(prefix)).map(buildNote),
        ),
    },
  });
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
