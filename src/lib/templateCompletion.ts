// Completion engine for `{{ ... }}` expressions (#284).
//
// Pure TypeScript — no DOM, no CodeMirror dependency. The CodeMirror
// adapter lives in src/components/Editor/templateAutocomplete.ts and
// delegates shape detection to this module.
//
// Input: the expression text inside the `{{ ... }}` block, from `{{` to
// the cursor. Output: the list of suggestions (name + kind + return type +
// optional doc) and the zero-based column where the replacement should
// start (i.e. the character position of the identifier prefix the user is
// currently typing — this maps to CodeMirror's `from`).
//
// Supported shapes (MVP — #284):
//   - root:               `{{|}}` or `{{v|}}`  →  suggest `vault`
//   - member chain:       `vault.|`, `vault.notes.|`, `vault.stats.|`
//   - after method call:  `vault.notes.first().|`, `vault.notes.where(x => x.v == 1).|`
//   - inside lambda body: `vault.notes.where(n => n.|)`, `..select(n => n.|)`
//   - frontmatter keys:   `vault.notes.first().property.|`  (uses dynamicKeys)
//
// Design: the engine walks the input left-to-right via a small tolerant
// tokenizer. State includes the current expression type (typeAtCursor),
// a scope stack (for lambda params), and a call stack (for tracking the
// lambda param type the next `(` opens). When the token stream ends, the
// remaining state points at the type whose members should be suggested.

import {
  ROOT_SCOPE,
  membersOf,
  collectionElementType,
  resolveTypeDescriptor,
  type MemberDescriptor,
  type TypeRef,
} from "./vaultApiDescriptor";

export interface CompletionItem {
  label: string;
  kind: "property" | "method" | "variable";
  /** Type the member evaluates to — shown as the detail line. */
  detail: string;
  doc?: string;
  /** Text to insert. For methods this is `name(` so the user lands inside args. */
  insertText: string;
}

export interface CompletionAnalysis {
  /** from-offset (relative to the start of the expression input). */
  from: number;
  /** Partial identifier being typed — used as the filter prefix. */
  prefix: string;
  /** Suggestions available at the cursor. */
  items: CompletionItem[];
}

export interface CompletionOptions {
  /** Frontmatter keys observed in the vault, used for `note.property.*`. */
  dynamicFrontmatterKeys?: readonly string[];
}

// --- Tokenizer (tolerant) ---

type TokKind =
  | "ident" | "num" | "str"
  | "dot" | "lparen" | "rparen" | "comma" | "arrow"
  | "lbracket" | "rbracket"
  | "op" | "unknown";

interface Tok {
  kind: TokKind;
  value: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === ".") { out.push({ kind: "dot", value: ".", pos: i }); i++; continue; }
    if (c === "(") { out.push({ kind: "lparen", value: "(", pos: i }); i++; continue; }
    if (c === ")") { out.push({ kind: "rparen", value: ")", pos: i }); i++; continue; }
    if (c === "[") { out.push({ kind: "lbracket", value: "[", pos: i }); i++; continue; }
    if (c === "]") { out.push({ kind: "rbracket", value: "]", pos: i }); i++; continue; }
    if (c === ",") { out.push({ kind: "comma", value: ",", pos: i }); i++; continue; }
    if (c === "=" && src[i + 1] === ">") {
      out.push({ kind: "arrow", value: "=>", pos: i }); i += 2; continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      const start = i; i++;
      while (i < src.length && /[\w$]/.test(src[i]!)) i++;
      out.push({ kind: "ident", value: src.slice(start, i), pos: start });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i; i++;
      while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
      out.push({ kind: "num", value: src.slice(start, i), pos: start });
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; const start = i; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i += 2; else i++;
      }
      if (src[i] === q) i++;
      out.push({ kind: "str", value: src.slice(start, i), pos: start });
      continue;
    }
    // Multi-char operators we don't care about semantically but must skip.
    if (/[!<>=+\-*/%&|?:]/.test(c)) {
      const start = i; i++;
      while (i < src.length && /[!<>=&|]/.test(src[i]!)) i++;
      out.push({ kind: "op", value: src.slice(start, i), pos: start });
      continue;
    }
    out.push({ kind: "unknown", value: c, pos: i });
    i++;
  }
  return out;
}

// --- Chain analyser ---
//
// Walks the tokens and returns the type of the expression up to the point
// where we need to emit completions. `lastTrigger` is either:
//   - "root"    → no chain yet; suggest ROOT_SCOPE
//   - "member"  → user typed `.x`; suggest members of `type`, filtered by `prefix`
//   - "none"    → user is still typing an identifier in root scope

interface CallFrame {
  /** Type that arrow inside this call would bind its param to. */
  lambdaParamType: TypeRef | null;
  /** Type the expression was at just before `(` — i.e. the method's return. */
  returnType: TypeRef | null;
  /** Whether this call pushed a lambda scope that must be popped on `)`. */
  scopePushed: boolean;
}

interface ChainState {
  /** Current expression's type; null while still in root scope. */
  type: TypeRef | null;
  /** Scope stack: {name → type}. Root scope contains `vault`. */
  scopes: Array<Record<string, TypeRef>>;
  /** Call stack: for each open `(`, the lambda param type arrow would bind. */
  calls: CallFrame[];
  /** The last method descriptor seen (used when entering a call). */
  pendingMethod: MemberDescriptor | null;
  /** The last identifier we emitted (used to bind lambda params after `=>`). */
  pendingLambdaParam: string | null;
}

export function analyzeCompletion(
  input: string,
  options: CompletionOptions = {},
): CompletionAnalysis {
  // Trim trailing identifier characters to compute the prefix.
  let prefixStart = input.length;
  while (prefixStart > 0 && /[\w$]/.test(input[prefixStart - 1]!)) {
    prefixStart--;
  }
  const prefix = input.slice(prefixStart);
  const preceding = input.slice(0, prefixStart);

  const rootMembers = () =>
    ROOT_SCOPE.filter((m) => m.name.startsWith(prefix)).map(toItem);

  // Root position (nothing meaningful preceding) — suggest root scope.
  const precTrim = preceding.trimEnd();
  if (precTrim.length === 0) {
    return { from: prefixStart, prefix, items: rootMembers() };
  }

  // Member-access position: preceding text ends with `.`
  if (precTrim.endsWith(".")) {
    const exprStr = precTrim.slice(0, -1);
    const type = resolveExpressionType(exprStr);
    if (!type) return { from: prefixStart, prefix, items: [] };
    const members = membersOf(type, options.dynamicFrontmatterKeys);
    const items = members
      .filter((m) => m.name.startsWith(prefix))
      .map(toItem);
    return { from: prefixStart, prefix, items };
  }

  // Arbitrary other position (e.g. inside operator expression) — fall back
  // to root scope, which handles `{{1 + v|`.
  return { from: prefixStart, prefix, items: rootMembers() };
}

// Resolves the type of a fully-typed expression substring (no trailing `.`).
// Returns null when the input is mal-formed or references unknown names.
export function resolveExpressionType(exprStr: string): TypeRef | null {
  const tokens = tokenize(exprStr);
  const state: ChainState = {
    type: null,
    scopes: [Object.fromEntries(
      ROOT_SCOPE.map((m) => [m.name, m.returns]),
    )],
    calls: [],
    pendingMethod: null,
    pendingLambdaParam: null,
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    switch (t.kind) {
      case "ident": {
        // Resolving an identifier in the current scope starts a fresh
        // expression (or binds a lambda param if the next token is `=>`).
        if (tokens[i + 1]?.kind === "arrow") {
          state.pendingLambdaParam = t.value;
          i++;
          continue;
        }
        const scope = state.scopes[state.scopes.length - 1]!;
        const type = scope[t.value];
        if (type === undefined) return null;
        state.type = type;
        state.pendingMethod = null;
        i++;
        continue;
      }
      case "dot": {
        if (state.type === null) return null;
        const next = tokens[i + 1];
        if (!next || next.kind !== "ident") return null;
        const members = membersOf(state.type);
        const member = members.find((m) => m.name === next.value);
        if (!member) return null;
        state.type = member.returns;
        state.pendingMethod = member;
        i += 2;
        continue;
      }
      case "lparen": {
        // Detect the `(ident) =>` arrow-group pattern: don't treat the
        // outer paren as a call, just bind the lambda param.
        const n1 = tokens[i + 1];
        const n2 = tokens[i + 2];
        const n3 = tokens[i + 3];
        if (n1?.kind === "ident" && n2?.kind === "rparen" && n3?.kind === "arrow") {
          state.pendingLambdaParam = n1.value;
          i += 3; // skip `(`, ident, `)`; `=>` handled next iteration
          continue;
        }
        state.calls.push({
          lambdaParamType: state.pendingMethod?.lambdaParam ?? null,
          returnType: state.type,
          scopePushed: false,
        });
        state.pendingMethod = null;
        i++;
        continue;
      }
      case "rparen": {
        const frame = state.calls.pop();
        if (frame) {
          // Restore the type to the method's return type. Inside the call
          // we may have reset state.type while processing sub-expressions.
          state.type = frame.returnType;
          if (frame.scopePushed && state.scopes.length > 1) {
            state.scopes.pop();
          }
        }
        i++;
        continue;
      }
      case "arrow": {
        const top = state.calls[state.calls.length - 1];
        const paramType = top?.lambdaParamType ?? "any";
        if (state.pendingLambdaParam) {
          state.scopes.push({
            ...state.scopes[state.scopes.length - 1]!,
            [state.pendingLambdaParam]: paramType,
          });
          if (top) top.scopePushed = true;
          state.pendingLambdaParam = null;
        }
        state.type = null;
        i++;
        continue;
      }
      case "comma": {
        // Reset sub-expression inside call args.
        state.type = null;
        state.pendingLambdaParam = null;
        i++;
        continue;
      }
      case "lbracket":
      case "rbracket":
      case "op":
      case "num":
      case "str":
      case "unknown":
        // Enough handling to not derail type tracking: these terminate
        // the current sub-expression but don't alter the outer type.
        state.type = null;
        state.pendingLambdaParam = null;
        i++;
        continue;
    }
  }

  return state.type;
}

function toItem(m: MemberDescriptor): CompletionItem {
  const insertText = m.kind === "method" ? `${m.name}(` : m.name;
  const item: CompletionItem = {
    label: m.name,
    kind: m.kind,
    detail: m.returns,
    insertText,
  };
  if (m.doc !== undefined) item.doc = m.doc;
  return item;
}

// Re-exports for tests / consumers.
export { resolveTypeDescriptor, collectionElementType };
