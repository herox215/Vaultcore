// Static type descriptors for the `{{ ... }}` expression language (#284).
//
// Single source of truth the autocomplete provider reads from. If the vault
// API in vaultApi.ts grows a new property or method, add it here too —
// tests in vaultApiDescriptor.test.ts pin the descriptor ↔ runtime shape.
//
// Design:
//   - Everything is a plain data structure (no classes, no runtime hooks)
//     so the completion engine can use it without executing user code.
//   - `Collection<T>` is parameterised; the descriptor stores "T" as a
//     placeholder and the completion engine substitutes the element type.
//   - `NoteProperties` has `dynamic: true` — its member set comes from the
//     active frontmatter keys, not from this file.

export type TypeRef = string; // e.g. "Note", "Collection<Note>", "string"

export type MemberKind = "property" | "method" | "variable";

export interface MemberDescriptor {
  kind: MemberKind;
  name: string;
  /** Return type. May contain the placeholder `T` for Collection<T> methods. */
  returns: TypeRef;
  /** For methods that take a lambda: the element type of the lambda's param. */
  lambdaParam?: TypeRef;
  /** Short one-line description for the completion popup. */
  doc?: string;
}

export interface TypeDescriptor {
  name: string;
  members: MemberDescriptor[];
  /** If true, `members` is augmented at runtime from context (frontmatter keys). */
  dynamic?: boolean;
}

// --- Type definitions ---

const VAULT: TypeDescriptor = {
  name: "Vault",
  members: [
    { kind: "property", name: "name", returns: "string", doc: "Vault folder name" },
    { kind: "property", name: "path", returns: "string", doc: "Absolute vault path" },
    { kind: "property", name: "notes", returns: "Collection<Note>" },
    { kind: "property", name: "folders", returns: "Collection<Folder>" },
    { kind: "property", name: "tags", returns: "Collection<Tag>" },
    { kind: "property", name: "bookmarks", returns: "Collection<Note>" },
    { kind: "property", name: "stats", returns: "VaultStats" },
  ],
};

const NOTE: TypeDescriptor = {
  name: "Note",
  members: [
    { kind: "property", name: "name", returns: "string", doc: "Filename" },
    { kind: "property", name: "path", returns: "string", doc: "Vault-relative path" },
    { kind: "property", name: "title", returns: "string", doc: "Filename without .md" },
    { kind: "property", name: "property", returns: "NoteProperties", doc: "Frontmatter" },
    { kind: "property", name: "content", returns: "string", doc: "Raw markdown" },
  ],
};

const FOLDER: TypeDescriptor = {
  name: "Folder",
  members: [
    { kind: "property", name: "name", returns: "string" },
    { kind: "property", name: "path", returns: "string" },
    { kind: "property", name: "notes", returns: "Collection<Note>",
      doc: "All notes in this folder (recursive, includes descendants)" },
  ],
};

const TAG: TypeDescriptor = {
  name: "Tag",
  members: [
    { kind: "property", name: "name", returns: "string" },
    { kind: "property", name: "count", returns: "number" },
  ],
};

const VAULT_STATS: TypeDescriptor = {
  name: "VaultStats",
  members: [
    { kind: "property", name: "noteCount", returns: "number" },
    { kind: "property", name: "tagCount", returns: "number" },
  ],
};

const NOTE_PROPERTIES: TypeDescriptor = {
  name: "NoteProperties",
  members: [],
  dynamic: true,
};

// Collection<T> — `T` is substituted by the completion engine.
const COLLECTION: TypeDescriptor = {
  name: "Collection<T>",
  members: [
    { kind: "method", name: "where", returns: "Collection<T>", lambdaParam: "T",
      doc: "Filter by predicate" },
    { kind: "method", name: "select", returns: "Collection<any>", lambdaParam: "T",
      doc: "Project each element" },
    { kind: "method", name: "sortBy", returns: "Collection<T>", lambdaParam: "T",
      doc: "Order by key" },
    { kind: "method", name: "take", returns: "Collection<T>",
      doc: "Keep the first n elements" },
    { kind: "method", name: "skip", returns: "Collection<T>",
      doc: "Drop the first n elements" },
    { kind: "method", name: "distinct", returns: "Collection<T>",
      doc: "Deduplicate by identity" },
    { kind: "method", name: "first", returns: "T",
      doc: "First element or null" },
    { kind: "method", name: "count", returns: "number",
      doc: "Number of elements" },
    { kind: "method", name: "any", returns: "boolean", lambdaParam: "T",
      doc: "True if any element matches (or collection is non-empty)" },
    { kind: "method", name: "all", returns: "boolean", lambdaParam: "T",
      doc: "True if every element matches" },
    { kind: "method", name: "groupBy", returns: "any", lambdaParam: "T",
      doc: "Group by a key selector" },
    { kind: "method", name: "toArray", returns: "any",
      doc: "Materialize as an array" },
  ],
};

export const TYPES: Record<string, TypeDescriptor> = {
  Vault: VAULT,
  Note: NOTE,
  Folder: FOLDER,
  Tag: TAG,
  VaultStats: VAULT_STATS,
  NoteProperties: NOTE_PROPERTIES,
  "Collection<T>": COLLECTION,
};

/** The set of identifiers visible at the root of a `{{ ... }}` expression. */
export const ROOT_SCOPE: MemberDescriptor[] = [
  { kind: "variable", name: "vault", returns: "Vault", doc: "The vault root" },
];

// --- Helpers ---

export function resolveTypeDescriptor(type: TypeRef): TypeDescriptor | null {
  if (TYPES[type]) return TYPES[type]!;
  if (type.startsWith("Collection<") && type.endsWith(">")) {
    return TYPES["Collection<T>"] ?? null;
  }
  return null;
}

export function collectionElementType(type: TypeRef): TypeRef | null {
  const m = type.match(/^Collection<(.+)>$/);
  return m ? m[1]! : null;
}

/**
 * Substitutes the `T` placeholder in a Collection method's return/param type
 * with the concrete element type of the receiver. `Collection<T>` with T=Note
 * and return `Collection<T>` → `Collection<Note>`.
 */
export function substituteT(returns: TypeRef, elementType: TypeRef): TypeRef {
  if (returns === "T") return elementType;
  return returns.replace(/\bT\b/g, elementType);
}

export function membersOf(
  type: TypeRef,
  dynamicKeys?: readonly string[],
): MemberDescriptor[] {
  const desc = resolveTypeDescriptor(type);
  if (!desc) return [];
  if (desc.dynamic && dynamicKeys) {
    // NoteProperties: materialise from frontmatter keys present in the vault.
    return dynamicKeys.map((name) => ({
      kind: "property" as const,
      name,
      returns: "any",
      doc: "Frontmatter key",
    }));
  }
  const element = collectionElementType(type);
  if (element) {
    return desc.members.map((m) => {
      const next: MemberDescriptor = {
        ...m,
        returns: substituteT(m.returns, element),
      };
      if (m.lambdaParam !== undefined) {
        next.lambdaParam = substituteT(m.lambdaParam, element);
      }
      return next;
    });
  }
  return desc.members;
}
