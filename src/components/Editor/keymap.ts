import type { KeyBinding } from "@codemirror/view";
import {
  type StateCommand,
  EditorSelection,
} from "@codemirror/state";

/**
 * Wrap (or un-wrap) the current selection with the given prefix/suffix.
 * If the selection is already wrapped, remove the wrapping (toggle).
 * Empty selection inserts prefix+suffix with cursor between them.
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
        // Toggle off -- remove wrapping
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

      // Toggle on -- add wrapping
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
 * Cmd/Ctrl+K -- replace the selection with `[selection](url)`.
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
      // Cursor inside the `(url)` -- positioned after the opening paren.
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
