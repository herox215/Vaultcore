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
import { flashField } from "./flashHighlight";

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
    flashField,
  ];
}
