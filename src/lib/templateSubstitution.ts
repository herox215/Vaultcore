/**
 * Substitute template variables in a string.
 *
 * Supported variables:
 *   {{date}}  → YYYY-MM-DD
 *   {{time}}  → HH:mm
 *   {{title}} → active note title (filename without .md extension)
 */
export function substituteTemplateVars(
  content: string,
  title: string,
): string {
  const now = new Date();

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const date = `${yyyy}-${mm}-${dd}`;

  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const time = `${hh}:${min}`;

  return content
    .replaceAll("{{date}}", date)
    .replaceAll("{{time}}", time)
    .replaceAll("{{title}}", title);
}
