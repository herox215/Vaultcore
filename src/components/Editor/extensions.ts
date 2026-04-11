// RC-02 DECISION (locked Phase 1 Wave 0):
// VaultCore uses an EXPLICIT CodeMirror 6 extension list, NOT `basicSetup`.
// Rationale: note apps (Obsidian, Typora) do not show line numbers by default;
// `basicSetup` would force a Phase 5 Polish task to hide them.
//
// Phase 1 extension list (built in Wave 3 / plan 01-03):
//   history()
//   drawSelection()
//   dropCursor()
//   indentOnInput()
//   bracketMatching()
//   closeBrackets()
//   highlightActiveLine()
//   EditorView.lineWrapping
//   keymap.of([...defaultKeymap, ...historyKeymap, ...vaultKeymap])
//   markdown({ extensions: [GFM] })
//   syntaxHighlighting(markdownHighlightStyle)
//   markdownTheme
//   autoSaveExtension(onSave)
//
// Explicitly NOT included: lineNumbers(), foldGutter().

export const RC_02_LOCKED = true as const;
