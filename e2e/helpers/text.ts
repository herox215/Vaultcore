/**
 * WebKitWebDriver quirk: `element.getText()` returns an empty string for
 * many elements that clearly have text content (confirmed via a diagnostic
 * spec that dumped `textContent` + `innerText` + layout rects). Chrome /
 * Gecko drivers don't have this issue, but tauri-driver on Linux is pinned
 * to WebKit. We bypass `getText` by reading the DOM `textContent` property
 * through WebDriver's "Get Element Property" endpoint.
 */
export async function textOf(element: WebdriverIO.Element): Promise<string> {
  const value = (await element.getProperty("textContent")) as string | null;
  return (value ?? "").trim();
}

/**
 * Convenience: map an element list to their textContent strings.
 * Uses WDIO v9's async $$.map (which resolves to the mapped array directly —
 * do NOT wrap in Promise.all).
 */
export async function textsOf(elements: WebdriverIO.ElementArray): Promise<string[]> {
  return elements.map((el) => textOf(el));
}
