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
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { wikiLinkCompletionSource } from "./wikiLinkAutocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { vaultKeymap } from "./keymap";
import { markdownTheme, markdownHighlightStyle } from "./theme";
import { autoSaveExtension } from "./autoSave";
import { flashField } from "./flashHighlight";
import { wikiLinkPlugin } from "./wikiLink";
import { livePreviewPlugin } from "./livePreview";
import { frontmatterPlugin } from "./frontmatterPlugin";
import { taskListPlugin } from "./taskList";
import { countsPlugin } from "./countsPlugin";
import type { PaneId } from "../../store/countsStore";
import { activeViewStore } from "../../store/activeViewStore";

// Debounce sidebar panel re-renders during typing: rapid docChanged updates
// otherwise flood PropertiesPanel and OutgoingLinksPanel with re-parses on
// every keystroke, causing visible flicker.
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
const DOC_VERSION_DEBOUNCE_MS = 200;

const docVersionBumpListener = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (bumpTimer !== null) clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    activeViewStore.bumpDocVersion();
  }, DOC_VERSION_DEBOUNCE_MS);
});

export function buildExtensions(
  onSave: (text: string) => void,
  paneId?: PaneId,
): Extension[] {
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({
      override: [wikiLinkCompletionSource],
      activateOnTyping: true,
      defaultKeymap: true,
    }),
    highlightActiveLine(),
    EditorView.lineWrapping,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
      ...vaultKeymap,
    ]),
    markdown({ extensions: [GFM], codeLanguages: languages }),
    syntaxHighlighting(markdownHighlightStyle),
    markdownTheme,
    autoSaveExtension(onSave),
    flashField,
    wikiLinkPlugin,
    livePreviewPlugin,
    frontmatterPlugin,
    taskListPlugin,
    docVersionBumpListener,
  ];

  if (paneId !== undefined) {
    extensions.push(countsPlugin(paneId));
  }

  return extensions;
}
