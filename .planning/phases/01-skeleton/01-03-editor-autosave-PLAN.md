---
phase: 01-skeleton
plan: 03
type: execute
wave: 3
depends_on:
  - "01-skeleton/00"
  - "01-skeleton/01"
  - "01-skeleton/02"
files_modified:
  - src/components/Editor/extensions.ts
  - src/components/Editor/keymap.ts
  - src/components/Editor/theme.ts
  - src/components/Editor/autoSave.ts
  - src/components/Editor/CMEditor.svelte
  - tests/keymap.test.ts
  - tests/autoSave.test.ts
autonomous: true
requirements:
  - EDIT-01
  - EDIT-02
  - EDIT-04
  - EDIT-09
must_haves:
  truths:
    - "CMEditor.svelte mounts a CodeMirror 6 EditorView in `onMount` and stores it in a plain `let` (NOT `$state`) per RESEARCH Risk 3"
    - "Extension stack uses the RC-02 explicit list (no basicSetup, no lineNumbers, no foldGutter)"
    - "Markdown syntax highlighting and GFM active: H1/H2/H3 render at 26/22/18px per UI-SPEC"
    - "Cmd/Ctrl+B, Cmd/Ctrl+I, Cmd/Ctrl+K wrap the current selection via `wrapSelection` helper; Mod+B toggles (removes when already wrapped)"
    - "Auto-save is a 2000ms idle debounce on `docChanged` — a single keystroke schedules exactly one save; successive keystrokes within 2s reset the timer"
    - "CMEditor emits save via injected `onSave` callback — no direct IPC in the component"
    - "keymap.test.ts and autoSave.test.ts go from `it.todo` to passing assertions"
  artifacts:
    - path: "src/components/Editor/extensions.ts"
      provides: "RC-02 explicit CM6 extension list assembly function"
      exports: ["buildExtensions"]
    - path: "src/components/Editor/keymap.ts"
      provides: "wrapSelection helper + vaultKeymap (Mod-B/I/K)"
      exports: ["wrapSelection", "vaultKeymap"]
    - path: "src/components/Editor/theme.ts"
      provides: "CM6 theme extension + markdown HighlightStyle using CSS variables"
      exports: ["markdownTheme", "markdownHighlightStyle"]
    - path: "src/components/Editor/autoSave.ts"
      provides: "autoSaveExtension — 2s idle debounce on docChanged"
      exports: ["autoSaveExtension"]
    - path: "src/components/Editor/CMEditor.svelte"
      provides: "Svelte 5 wrapper mounting EditorView with onMount/onDestroy"
  key_links:
    - from: "src/components/Editor/CMEditor.svelte"
      to: "src/components/Editor/extensions.ts"
      via: "buildExtensions(onSave)"
      pattern: "buildExtensions\\("
    - from: "src/components/Editor/autoSave.ts"
      to: "@codemirror/view::EditorView.updateListener"
      via: "extension factory"
      pattern: "updateListener"
    - from: "src/components/Editor/keymap.ts"
      to: "@codemirror/state::EditorSelection"
      via: "changeByRange"
      pattern: "changeByRange"
---

<objective>
Build the CodeMirror 6 Svelte wrapper and its extension stack. Implement the RC-02-locked explicit extension list (NO `basicSetup`, NO line numbers, NO fold gutter), the UI-SPEC CM6 theme (H1/H2/H3 size scale via CSS variables, accent cursor, accent-bg selection, 720px max-width line length), the Markdown + GFM highlight, the `wrapSelection` helper wiring Cmd/Ctrl+B/I/K with toggle-off behavior, and the `autoSaveExtension` — a 2000ms idle debounce on `docChanged`. Upgrade `keymap.test.ts` and `autoSave.test.ts` from `it.todo` to real passing assertions.

Purpose: After this plan, the CodeMirror editor exists as a self-contained Svelte component with a clean injection interface (`content: string, onSave: (text) => void`). Plan 01-04 will mount it inside the VaultView and wire `onSave` to `writeFile` from `src/ipc/commands.ts`. Keystroke latency stays under 16ms per PERF-04 because the wrapper uses `updateListener` (CM6-native) for content observation, NOT Svelte `$effect` reactivity per-keystroke.

Output: A `CMEditor.svelte` component that plan 01-04 can drop into the VaultView, plus green Vitest coverage for EDIT-04 (wrapSelection) and EDIT-09 (auto-save debounce).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/01-skeleton/01-CONTEXT.md
@.planning/phases/01-skeleton/01-RESEARCH.md
@.planning/phases/01-skeleton/01-UI-SPEC.md
@.planning/phases/01-skeleton/01-VALIDATION.md
@.planning/phases/01-skeleton/01-00-SUMMARY.md
@src/components/Editor/extensions.ts
@src/styles/tailwind.css
@tests/keymap.test.ts
@tests/autoSave.test.ts

<interfaces>
<!-- CMEditor.svelte props contract — consumed by plan 01-04 -->

interface CMEditorProps {
  content: string;           // initial document content
  onSave: (text: string) => void; // called 2000ms after last keystroke
  // Content is NOT reactive after initial mount. To switch files, unmount + remount
  // (Svelte `{#key}` block in the parent) so we reset CM6 history cleanly.
}

// Extension stack (RC-02 locked, from Wave 0 comment in extensions.ts header):
//   history()
//   drawSelection()
//   dropCursor()
//   indentOnInput()
//   bracketMatching()
//   closeBrackets()
//   highlightActiveLine()
//   EditorView.lineWrapping
//   keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...vaultKeymap])
//   markdown({ extensions: [GFM] })
//   syntaxHighlighting(markdownHighlightStyle)
//   markdownTheme
//   autoSaveExtension(onSave)
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: keymap.ts wrapSelection helper + vaultKeymap + EDIT-04 tests</name>
  <files>src/components/Editor/keymap.ts, tests/keymap.test.ts</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §3.4 Keyboard Shortcuts: Wrap Selection (complete sample code)
    - .planning/phases/01-skeleton/01-CONTEXT.md D-13 (Mod+B wraps **...**, Mod+I wraps *...*, Mod+K wraps [text](url))
    - tests/keymap.test.ts (it.todo stubs)
  </read_first>
  <behavior>
    - `wrapSelection("**", "**")` as a `StateCommand`:
      - Input `|foo|` (selection "foo") → `**foo|**` with selection preserved around "foo"
      - Input `**|foo|**` (already wrapped) → `|foo|` (toggle off)
      - Input `||` (empty selection) → `**|**` with cursor between the markers
    - `wrapLink`: on non-empty selection, produces `[foo](url)` with cursor placed inside `(url)`; on empty selection, produces `[link text](url)`
    - `vaultKeymap`: three bindings with keys `Mod-b`, `Mod-i`, `Mod-k`
  </behavior>
  <action>
    1. **Create `src/components/Editor/keymap.ts`:**
       ```typescript
       import type { KeyBinding } from "@codemirror/view";
       import {
         type StateCommand,
         EditorSelection,
       } from "@codemirror/state";

       /**
        * Wrap (or un-wrap) the current selection with the given prefix/suffix.
        * If the selection is already wrapped, remove the wrapping (toggle).
        */
       export function wrapSelection(prefix: string, suffix: string): StateCommand {
         return ({ state, dispatch }) => {
           const changes = state.changeByRange((range) => {
             const before = state.sliceDoc(
               range.from - prefix.length,
               range.from
             );
             const after = state.sliceDoc(range.to, range.to + suffix.length);

             if (before === prefix && after === suffix) {
               // Toggle off — remove wrapping
               return {
                 changes: [
                   { from: range.from - prefix.length, to: range.from, insert: "" },
                   { from: range.to, to: range.to + suffix.length, insert: "" },
                 ],
                 range: EditorSelection.range(
                   range.from - prefix.length,
                   range.to - prefix.length
                 ),
               };
             }

             // Toggle on — add wrapping
             return {
               changes: [
                 { from: range.from, insert: prefix },
                 { from: range.to, insert: suffix },
               ],
               range: EditorSelection.range(
                 range.from + prefix.length,
                 range.to + prefix.length
               ),
             };
           });
           dispatch(state.update(changes, { scrollIntoView: true }));
           return true;
         };
       }

       /**
        * Cmd/Ctrl+K — replace the selection with `[selection](url)`.
        * Cursor lands inside the `(url)` so user can type the URL immediately.
        */
       export const wrapLink: StateCommand = ({ state, dispatch }) => {
         const changes = state.changeByRange((range) => {
           const selected = state.sliceDoc(range.from, range.to);
           const linkText = selected.length > 0 ? selected : "link text";
           const before = `[${linkText}](`;
           const insert = `${before}url)`;
           return {
             changes: { from: range.from, to: range.to, insert },
             // Cursor inside the `(url)` — positioned after the opening paren.
             range: EditorSelection.range(
               range.from + before.length,
               range.from + before.length + "url".length
             ),
           };
         });
         dispatch(state.update(changes, { scrollIntoView: true }));
         return true;
       };

       export const vaultKeymap: KeyBinding[] = [
         { key: "Mod-b", run: wrapSelection("**", "**") },
         { key: "Mod-i", run: wrapSelection("*", "*") },
         { key: "Mod-k", run: wrapLink },
       ];
       ```

    2. **Upgrade `tests/keymap.test.ts`** — EDIT-04 assertions, using a real `EditorState` (no DOM needed):
       ```typescript
       import { describe, it, expect } from "vitest";
       import { EditorState, EditorSelection } from "@codemirror/state";
       import { wrapSelection, wrapLink } from "../src/components/Editor/keymap";

       function makeState(doc: string, selFrom: number, selTo: number): EditorState {
         return EditorState.create({
           doc,
           selection: EditorSelection.single(selFrom, selTo),
         });
       }

       function runCommand(
         state: EditorState,
         cmd: ReturnType<typeof wrapSelection> | typeof wrapLink
       ): { doc: string; selFrom: number; selTo: number } {
         let captured: EditorState = state;
         cmd({
           state,
           dispatch: (tr) => {
             captured = tr.state;
           },
         });
         const sel = captured.selection.main;
         return { doc: captured.doc.toString(), selFrom: sel.from, selTo: sel.to };
       }

       describe("EDIT-04: wrapSelection keymap commands", () => {
         it("EDIT-04: Mod-b wraps selection with ** on both sides", () => {
           const state = makeState("foo bar baz", 4, 7); // "bar"
           const out = runCommand(state, wrapSelection("**", "**"));
           expect(out.doc).toBe("foo **bar** baz");
           // selection now wraps just "bar" (without the asterisks)
           expect(out.doc.slice(out.selFrom, out.selTo)).toBe("bar");
         });

         it("EDIT-04: Mod-b on already-wrapped selection removes the ** wrapping (toggle)", () => {
           const state = makeState("foo **bar** baz", 6, 9); // "bar" inside **bar**
           const out = runCommand(state, wrapSelection("**", "**"));
           expect(out.doc).toBe("foo bar baz");
           expect(out.doc.slice(out.selFrom, out.selTo)).toBe("bar");
         });

         it("EDIT-04: Mod-i wraps selection with * on both sides", () => {
           const state = makeState("hello world", 6, 11); // "world"
           const out = runCommand(state, wrapSelection("*", "*"));
           expect(out.doc).toBe("hello *world*");
           expect(out.doc.slice(out.selFrom, out.selTo)).toBe("world");
         });

         it("EDIT-04: Mod-i on already-wrapped selection toggles off", () => {
           const state = makeState("hello *world*", 7, 12); // "world" inside *world*
           const out = runCommand(state, wrapSelection("*", "*"));
           expect(out.doc).toBe("hello world");
         });

         it("EDIT-04: Mod-k on non-empty selection replaces with [text](url) and positions cursor inside (url)", () => {
           const state = makeState("click here", 6, 10); // "here"
           const out = runCommand(state, wrapLink);
           expect(out.doc).toBe("click [here](url)");
           // cursor lands inside `(url)` — selection covers the `url` placeholder
           expect(out.doc.slice(out.selFrom, out.selTo)).toBe("url");
         });

         it("EDIT-04: Mod-k on empty selection inserts [link text](url)", () => {
           const state = makeState("prefix ", 7, 7); // empty cursor
           const out = runCommand(state, wrapLink);
           expect(out.doc).toBe("prefix [link text](url)");
         });
       });
       ```
  </action>
  <verify>
    <automated>pnpm vitest run tests/keymap.test.ts &amp;&amp; pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `src/components/Editor/keymap.ts` contains `export function wrapSelection` AND `export const wrapLink` AND `export const vaultKeymap`
    - `grep -c "changeByRange" src/components/Editor/keymap.ts` returns at least 2
    - `grep -c "EditorSelection.range" src/components/Editor/keymap.ts` returns at least 2
    - `grep -c "Mod-b" src/components/Editor/keymap.ts` returns 1
    - `grep -c "Mod-i" src/components/Editor/keymap.ts` returns 1
    - `grep -c "Mod-k" src/components/Editor/keymap.ts` returns 1
    - `tests/keymap.test.ts` does NOT contain `it.todo`
    - `pnpm vitest run tests/keymap.test.ts` exits 0 with at least 6 passed
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>wrapSelection helper with toggle-off behavior, vaultKeymap bindings for Mod+B/I/K, six EDIT-04 assertions green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: autoSave.ts extension + EDIT-09 fake-timer tests</name>
  <files>src/components/Editor/autoSave.ts, tests/autoSave.test.ts</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §3.5 Auto-Save: Fixed 2s Idle Timer (complete sample), §8 Risk 4 (idle debounce interpretation)
    - .planning/phases/01-skeleton/01-CONTEXT.md EDIT-09 (2s, no manual save, no dirty indicator)
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Auto-save: No visual indicator"
    - tests/autoSave.test.ts (it.todo stubs)
  </read_first>
  <behavior>
    - `autoSaveExtension(onSave)` returns a CM6 extension that listens for `docChanged === true` updates and schedules `onSave(docString)` to fire 2000ms later
    - Successive `docChanged` updates within 2000ms cancel the previous timer (debounce)
    - Updates where `docChanged === false` (e.g., selection-only changes) do NOT schedule a save
    - Exported factory is pure — no module-level singleton state
  </behavior>
  <action>
    1. **Create `src/components/Editor/autoSave.ts`:**
       ```typescript
       import { EditorView } from "@codemirror/view";
       import type { Extension } from "@codemirror/state";

       const AUTO_SAVE_DEBOUNCE_MS = 2000;

       /**
        * EDIT-09: 2-second idle debounce on docChanged.
        * A single keystroke schedules exactly one onSave call 2000 ms later.
        * Successive keystrokes within 2000 ms reset the timer.
        * Non-doc-change updates (selection-only) are ignored.
        *
        * This factory is pure — each call creates a new extension with its own
        * timer closure, so it's safe to use multiple editors in the same page.
        */
       export function autoSaveExtension(
         onSave: (text: string) => void
       ): Extension {
         let timer: ReturnType<typeof setTimeout> | null = null;

         return EditorView.updateListener.of((update) => {
           if (!update.docChanged) return;
           if (timer !== null) clearTimeout(timer);
           timer = setTimeout(() => {
             onSave(update.state.doc.toString());
             timer = null;
           }, AUTO_SAVE_DEBOUNCE_MS);
         });
       }

       export const AUTO_SAVE_DEBOUNCE_FOR_TESTS = AUTO_SAVE_DEBOUNCE_MS;
       ```

    2. **Upgrade `tests/autoSave.test.ts`** — EDIT-09 assertions with fake timers. Uses `EditorView` with a jsdom container to drive real CM6 transactions:
       ```typescript
       import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
       import { EditorState } from "@codemirror/state";
       import { EditorView } from "@codemirror/view";
       import {
         autoSaveExtension,
         AUTO_SAVE_DEBOUNCE_FOR_TESTS,
       } from "../src/components/Editor/autoSave";

       function makeView(onSave: (text: string) => void, doc: string = ""): EditorView {
         const parent = document.createElement("div");
         document.body.appendChild(parent);
         return new EditorView({
           state: EditorState.create({
             doc,
             extensions: [autoSaveExtension(onSave)],
           }),
           parent,
         });
       }

       beforeEach(() => {
         vi.useFakeTimers();
       });

       afterEach(() => {
         vi.useRealTimers();
       });

       describe("EDIT-09: auto-save 2s idle debounce", () => {
         it("EDIT-09: a single keystroke schedules onSave exactly once after 2000 ms", () => {
           const onSave = vi.fn();
           const view = makeView(onSave, "");
           view.dispatch({ changes: { from: 0, insert: "h" } });
           expect(onSave).not.toHaveBeenCalled();
           vi.advanceTimersByTime(AUTO_SAVE_DEBOUNCE_FOR_TESTS - 1);
           expect(onSave).not.toHaveBeenCalled();
           vi.advanceTimersByTime(2);
           expect(onSave).toHaveBeenCalledTimes(1);
           expect(onSave).toHaveBeenCalledWith("h");
           view.destroy();
         });

         it("EDIT-09: successive keystrokes within 2000 ms reset the debounce (only one save fires)", () => {
           const onSave = vi.fn();
           const view = makeView(onSave, "");
           view.dispatch({ changes: { from: 0, insert: "a" } });
           vi.advanceTimersByTime(500);
           view.dispatch({ changes: { from: 1, insert: "b" } });
           vi.advanceTimersByTime(500);
           view.dispatch({ changes: { from: 2, insert: "c" } });
           // After 1000ms total — nothing saved yet (each keystroke reset the timer)
           vi.advanceTimersByTime(1000);
           expect(onSave).not.toHaveBeenCalled();
           // After an additional 1001 ms (so 2001 ms since last keystroke) — save fires
           vi.advanceTimersByTime(1001);
           expect(onSave).toHaveBeenCalledTimes(1);
           expect(onSave).toHaveBeenCalledWith("abc");
           view.destroy();
         });

         it("EDIT-09: docChanged === false (selection-only transaction) does not schedule a save", () => {
           const onSave = vi.fn();
           const view = makeView(onSave, "hello");
           // Selection-only change — no doc edit
           view.dispatch({ selection: { anchor: 2, head: 4 } });
           vi.advanceTimersByTime(AUTO_SAVE_DEBOUNCE_FOR_TESTS + 100);
           expect(onSave).not.toHaveBeenCalled();
           view.destroy();
         });

         it("EDIT-09: second keystroke after first save fires a second save", () => {
           const onSave = vi.fn();
           const view = makeView(onSave, "");
           view.dispatch({ changes: { from: 0, insert: "a" } });
           vi.advanceTimersByTime(2001);
           expect(onSave).toHaveBeenCalledTimes(1);
           view.dispatch({ changes: { from: 1, insert: "b" } });
           vi.advanceTimersByTime(2001);
           expect(onSave).toHaveBeenCalledTimes(2);
           expect(onSave).toHaveBeenLastCalledWith("ab");
           view.destroy();
         });
       });
       ```

    Note on jsdom: CodeMirror 6 EditorView renders into a real DOM; jsdom provides enough DOM APIs (including `MutationObserver`, `Range`, `ResizeObserver` may need polyfill). If `ResizeObserver` is missing, add to `src/test/setup.ts`:
    ```typescript
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
    ```
    Check first by running the test; only add the polyfill if jsdom throws `ResizeObserver is not defined`.
  </action>
  <verify>
    <automated>pnpm vitest run tests/autoSave.test.ts &amp;&amp; pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `src/components/Editor/autoSave.ts` contains `AUTO_SAVE_DEBOUNCE_MS = 2000` AND `EditorView.updateListener.of` AND `update.docChanged` AND `clearTimeout`
    - `grep -c "export function autoSaveExtension" src/components/Editor/autoSave.ts` returns 1
    - `tests/autoSave.test.ts` does NOT contain `it.todo`
    - `pnpm vitest run tests/autoSave.test.ts` exits 0 with at least 4 passed
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>autoSaveExtension is a pure factory with 2s debounce, docChanged gate, four EDIT-09 assertions green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: theme.ts + extensions.ts (RC-02 list) + CMEditor.svelte wrapper</name>
  <files>
    src/components/Editor/theme.ts,
    src/components/Editor/extensions.ts,
    src/components/Editor/CMEditor.svelte
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-UI-SPEC.md "CodeMirror 6 Editor" (extension stack, theme values, perf contract, line wrapping)
    - .planning/phases/01-skeleton/01-RESEARCH.md §3.1 Mount/Unmount, §3.2 setState, §3.3 HighlightStyle, §8 Risk 3 (RC-01), RC-02
    - .planning/phases/01-skeleton/01-CONTEXT.md D-10, D-13
    - src/components/Editor/extensions.ts (RC-02 header comment from Wave 0 — keep the comment, replace RC_02_LOCKED stub with real buildExtensions)
    - src/components/Editor/keymap.ts, src/components/Editor/autoSave.ts (from Tasks 1 and 2)
  </read_first>
  <behavior>
    - `markdownTheme`: CM6 theme that sets `--color-surface` background, 15px base font, 16px inner padding, 720px max-width, accent cursor, accent-bg selection
    - `markdownHighlightStyle`: H1=26px/700, H2=22px/700, H3=18px/700, bold=700, italic=italic, inline code in monospace 13px with surface bg
    - `buildExtensions(onSave)` assembles the RC-02 explicit list (history, drawSelection, dropCursor, indentOnInput, bracketMatching, closeBrackets, highlightActiveLine, EditorView.lineWrapping, keymap with defaultKeymap + historyKeymap + closeBracketsKeymap + vaultKeymap, markdown+GFM, syntaxHighlighting, markdownTheme, autoSaveExtension)
    - `CMEditor.svelte`: Svelte 5 component with `{ content, onSave }` props, mounts `EditorView` in `onMount` into a `bind:this` ref, destroys in `onDestroy`, stores view in plain `let` NOT `$state`
  </behavior>
  <action>
    1. **`src/components/Editor/theme.ts`:**
       ```typescript
       import { EditorView } from "@codemirror/view";
       import { HighlightStyle } from "@codemirror/language";
       import { tags } from "@lezer/highlight";

       export const markdownHighlightStyle = HighlightStyle.define([
         { tag: tags.heading1, fontSize: "26px", fontWeight: "700" },
         { tag: tags.heading2, fontSize: "22px", fontWeight: "700" },
         { tag: tags.heading3, fontSize: "18px", fontWeight: "700" },
         { tag: tags.heading4, fontSize: "16px", fontWeight: "700" },
         { tag: tags.heading5, fontSize: "15px", fontWeight: "700" },
         { tag: tags.heading6, fontSize: "15px", fontWeight: "700" },
         { tag: tags.strong, fontWeight: "700" },
         { tag: tags.emphasis, fontStyle: "italic" },
         { tag: tags.monospace, fontFamily: "var(--vc-font-mono)" },
         { tag: tags.link, color: "var(--color-accent)", textDecoration: "underline" },
         { tag: tags.url, color: "var(--color-accent)" },
         { tag: tags.comment, color: "var(--color-text-muted)", fontStyle: "italic" },
       ]);

       export const markdownTheme = EditorView.theme({
         "&": {
           backgroundColor: "var(--color-surface)",
           color: "var(--color-text)",
           height: "100%",
           fontSize: "15px",
           fontFamily: "var(--vc-font-body)",
         },
         ".cm-scroller": { overflow: "auto" },
         ".cm-content": {
           padding: "16px",
           maxWidth: "720px",
           margin: "0 auto",
           caretColor: "var(--color-accent)",
         },
         ".cm-line": { lineHeight: "1.6" },
         ".cm-cursor, .cm-dropCursor": {
           borderLeftColor: "var(--color-accent)",
         },
         "&.cm-focused .cm-selectionBackground, ::selection": {
           backgroundColor: "var(--color-accent-bg)",
         },
         ".cm-activeLine": {
           backgroundColor: "transparent",
         },
         // Monospace inline code (styled by HighlightStyle fontFamily; add bg here)
         ".cm-content .tok-monospace": {
           backgroundColor: "#F3F4F6",
           borderRadius: "3px",
           padding: "1px 4px",
           fontSize: "13px",
         },
       });
       ```

    2. **`src/components/Editor/extensions.ts`** — keep the Wave 0 RC-02 header comment and replace `RC_02_LOCKED` with the real `buildExtensions`:
       ```typescript
       // RC-02 DECISION (locked Phase 1 Wave 0):
       // VaultCore uses an EXPLICIT CodeMirror 6 extension list, NOT `basicSetup`.
       // Rationale: note apps (Obsidian, Typora) do not show line numbers by default.
       //
       // Phase 1 extension list: history, drawSelection, dropCursor, indentOnInput,
       //   bracketMatching, closeBrackets, highlightActiveLine, EditorView.lineWrapping,
       //   keymap(defaultKeymap + historyKeymap + closeBracketsKeymap + vaultKeymap),
       //   markdown({ extensions: [GFM] }), syntaxHighlighting(markdownHighlightStyle),
       //   markdownTheme, autoSaveExtension(onSave).
       //
       // Explicitly NOT included: lineNumbers(), foldGutter().

       import type { Extension } from "@codemirror/state";
       import { EditorView, drawSelection, dropCursor, highlightActiveLine, keymap } from "@codemirror/view";
       import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
       import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
       import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
       import { markdown } from "@codemirror/lang-markdown";
       import { GFM } from "@lezer/markdown";

       import { vaultKeymap } from "./keymap";
       import { markdownTheme, markdownHighlightStyle } from "./theme";
       import { autoSaveExtension } from "./autoSave";

       export function buildExtensions(onSave: (text: string) => void): Extension[] {
         return [
           history(),
           drawSelection(),
           dropCursor(),
           indentOnInput(),
           bracketMatching(),
           closeBrackets(),
           highlightActiveLine(),
           EditorView.lineWrapping,
           keymap.of([
             ...closeBracketsKeymap,
             ...defaultKeymap,
             ...historyKeymap,
             indentWithTab,
             ...vaultKeymap,
           ]),
           markdown({ extensions: [GFM] }),
           syntaxHighlighting(markdownHighlightStyle),
           markdownTheme,
           autoSaveExtension(onSave),
         ];
       }
       ```

    Note on `@codemirror/autocomplete` and `@lezer/markdown`: these are transitive deps of `@codemirror/lang-markdown` and `codemirror` respectively, already in the lockfile from plan 01-00. If `pnpm typecheck` reports missing types, add explicit installs: `pnpm add @codemirror/autocomplete @codemirror/commands @lezer/markdown`.

    3. **`src/components/Editor/CMEditor.svelte`:**
       ```svelte
       <script lang="ts">
         import { onMount, onDestroy } from "svelte";
         import { EditorView } from "@codemirror/view";
         import { EditorState } from "@codemirror/state";
         import { buildExtensions } from "./extensions";

         let {
           content,
           onSave,
         }: {
           content: string;
           onSave: (text: string) => void;
         } = $props();

         let container: HTMLDivElement | undefined = $state();

         // RESEARCH §8 Risk 3 / RC-01: EditorView must NOT be wrapped in $state.
         // Svelte's reactive Proxy would intercept internal CM6 field access and
         // break the editor's change detection. Use plain `let` instead.
         let view: EditorView | null = null;

         onMount(() => {
           if (!container) return;
           view = new EditorView({
             state: EditorState.create({
               doc: content,
               extensions: buildExtensions(onSave),
             }),
             parent: container,
           });
         });

         onDestroy(() => {
           view?.destroy();
           view = null;
         });
       </script>

       <div bind:this={container} class="vc-cm-editor" data-testid="cm-editor"></div>

       <style>
         .vc-cm-editor {
           width: 100%;
           height: 100%;
           background: var(--color-surface);
         }
       </style>
       ```

    Run `pnpm typecheck` and `pnpm build` to confirm the full frontend compiles with the new editor module.
  </action>
  <verify>
    <automated>pnpm typecheck &amp;&amp; pnpm build &amp;&amp; pnpm vitest run</automated>
  </verify>
  <acceptance_criteria>
    - `src/components/Editor/theme.ts` contains `HighlightStyle.define` AND `tags.heading1` AND `fontSize: "26px"` AND `tags.heading2` AND `fontSize: "22px"` AND `tags.heading3` AND `fontSize: "18px"` AND `caretColor: "var(--color-accent)"`
    - `src/components/Editor/extensions.ts` contains `RC-02 DECISION` AND `export function buildExtensions`
    - `src/components/Editor/extensions.ts` does NOT contain `basicSetup` (RC-02 enforcement)
    - `src/components/Editor/extensions.ts` does NOT contain `lineNumbers` or `foldGutter` (RC-02 enforcement)
    - `src/components/Editor/extensions.ts` contains `history()`, `drawSelection()`, `dropCursor()`, `indentOnInput()`, `bracketMatching()`, `closeBrackets()`, `highlightActiveLine()`, `EditorView.lineWrapping`, `markdown({ extensions: [GFM] })`, `syntaxHighlighting(markdownHighlightStyle)`, `autoSaveExtension(onSave)`, `vaultKeymap`
    - `src/components/Editor/CMEditor.svelte` contains `onMount(` AND `onDestroy(` AND `buildExtensions(onSave)`
    - `src/components/Editor/CMEditor.svelte` contains the comment `NOT be wrapped in $state` (or equivalent) AND declares `let view: EditorView | null = null;` (plain let, NOT `$state`)
    - `grep -c "\\\$state(new EditorView" src/components/Editor/CMEditor.svelte` returns 0 (RC-01 enforcement)
    - `pnpm typecheck` exits 0
    - `pnpm build` exits 0
    - `pnpm vitest run` exits 0 overall (keymap + autoSave + prior Toast/Welcome/vault tests still green)
  </acceptance_criteria>
  <done>Theme, extension list, and Svelte wrapper compile. CMEditor.svelte is ready for plan 01-04 to mount. All Phase 1 Vitest suites green.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User keystroke → CM6 transaction | Direct DOM event → CM6 dispatch pipeline |
| CM6 document state → onSave callback | Document content crosses from CM6 state back to Svelte consumer |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03 | Tampering (binary corruption via auto-save) | `CMEditor.svelte` + `autoSaveExtension` | mitigate | Plan 01-01 `read_file` rejects non-UTF-8 files with `VaultError::InvalidEncoding`, so non-UTF-8 content is NEVER loaded into CM6. This plan's contribution: `onSave` is called with `update.state.doc.toString()` which is always a valid JS string; there is no path by which binary bytes reach the save callback. |
| T-04 | Tampering (JS string → Rust byte round-trip) | `autoSave.ts` → `writeFile` | mitigate | `writeFile` in plan 01-02 passes the string through `invoke<string>("write_file", { path, content })`; Tauri v2 core serializes JS strings as UTF-8 bytes. No manual encoding/decoding. The test `write_file_writes_bytes_and_returns_hash` in plan 01-01 confirms the byte-accurate round-trip. |
| T-03-R | Repudiation (silent save failure) | `autoSave.ts` | mitigate | Plan 01-04's wiring task will wrap the `onSave` callback in try/catch and push a toast on failure. This plan's `autoSaveExtension` is callback-agnostic — it doesn't silently swallow errors. |
| T-03-D | Denial of Service (runaway autocomplete in CM6) | `closeBrackets()` extension | accept | RESEARCH Risk 6 flags that `closeBrackets` may conflict with future `[[` wiki-link typing in Phase 4. Accepted for Phase 1 — Phase 4 replan will revisit. |
| T-03-E | Elevation (Proxy injection through Svelte $state) | `CMEditor.svelte` | mitigate | Task 3 stores `EditorView` in a plain `let`, NOT `$state`. A comment above the declaration explains why. Acceptance criterion greps for the absence of `$state(new EditorView`. This closes the RC-01 risk that a future edit wraps the view in `$state` and breaks CM6 silently. |
</threat_model>

<verification>
- `pnpm vitest run` passes all keymap + autoSave tests plus prior Wave 2 tests
- `pnpm typecheck` green
- `pnpm build` green
- `grep -c "basicSetup" src/components/Editor/extensions.ts` returns 0 (RC-02)
- `grep -c "lineNumbers\\|foldGutter" src/components/Editor/extensions.ts` returns 0 (RC-02)
- `grep -c "\\\$state(new EditorView" src/components/Editor/` returns 0 (RC-01 / RISK-3)
</verification>

<success_criteria>
1. wrapSelection + vaultKeymap with six EDIT-04 assertions green
2. autoSaveExtension with four EDIT-09 fake-timer assertions green
3. RC-02 explicit extension list committed (no basicSetup, no line numbers, no fold gutter)
4. CMEditor.svelte mounts EditorView in onMount, stores it in plain `let`, destroys in onDestroy
5. Full frontend builds and typechecks
6. RISK-3 $state proxy issue prevented by grep check
</success_criteria>

<output>
After completion, create `.planning/phases/01-skeleton/01-03-SUMMARY.md` per summary template.
</output>
