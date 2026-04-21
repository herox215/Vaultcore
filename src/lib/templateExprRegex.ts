// Shared regex for the outer `{{ ... }}` boundary of template expressions.
//
// Extracted into its own tiny module so it can be imported by both
// `templateScope.ts` (the canonical consumer — CM6 live-preview and Reading
// Mode) and `vaultApi.ts` (which strips expression bodies from `n.content`
// so self-referential searches like `vault.notes.where(n => n.content
// .contains("todo"))` don't match the note the template lives in — #325).
// Keeping the regex here prevents a runtime cycle between `vaultApi.ts`
// and `templateScope.ts` (which imports the bridge which imports vaultApi).
//
// The class `[^{}]` rejects `{` or `}` inside the body, which means
// expression-body string literals containing a brace (e.g. `{{ "a{b" }}`)
// do not match. That matches the CM6 live-preview plugin's behaviour.
// `\r` and `\n` are allowed so multi-line templates are stripped as a
// single unit.

export const TEMPLATE_EXPR_RE = /\{\{([^{}]+?)\}\}/g;

/**
 * Replace every `{{ ... }}` region in `text` with an empty string.
 *
 * Used by the template-facing `.content` accessor so user predicates
 * (`.contains`, `.includes`, `.indexOf`, etc.) see the note's prose, not
 * the code inside its own templates. Template bodies are syntactically
 * nested inside the note file but semantically they are computed output —
 * a predicate searching for "todo" should not match a template whose body
 * reads `vault.notes.where(n => n.content.contains("todo"))`.
 *
 * Using `.replace()` naturally handles the `g` flag's `lastIndex` state,
 * so the function is safe to call repeatedly without re-setting the regex.
 */
export function stripTemplateExpressions(text: string): string {
  return text.replace(TEMPLATE_EXPR_RE, "");
}
