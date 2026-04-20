// Unit tests for the docs-page path helpers (#285).

import { describe, it, expect } from "vitest";
import {
  DOCS_PAGE_REL,
  docsPagePath,
  isDocsPagePath,
  docsTabLabel,
} from "../docsPage";

describe("docsPage helpers", () => {
  it("DOCS_PAGE_REL sits inside .vaultcore/", () => {
    expect(DOCS_PAGE_REL).toBe(".vaultcore/DOCS.md");
  });

  it("docsPagePath joins vault + relative with forward slash", () => {
    expect(docsPagePath("/Users/x/MyVault")).toBe(
      "/Users/x/MyVault/.vaultcore/DOCS.md",
    );
  });

  it("docsPagePath normalises Windows-style backslashes", () => {
    expect(docsPagePath("C:\\vaults\\Notes")).toBe(
      "C:/vaults/Notes/.vaultcore/DOCS.md",
    );
  });

  it("isDocsPagePath matches the exact suffix", () => {
    expect(isDocsPagePath("/v/My/.vaultcore/DOCS.md")).toBe(true);
    expect(isDocsPagePath("C:\\v\\My\\.vaultcore\\DOCS.md")).toBe(true);
  });

  it("isDocsPagePath rejects unrelated paths", () => {
    expect(isDocsPagePath("/v/My/DOCS.md")).toBe(false);
    expect(isDocsPagePath("/v/My/.vaultcore/other.md")).toBe(false);
    expect(isDocsPagePath("/v/My/note.md")).toBe(false);
    // Case sensitivity — the file is literally DOCS.md.
    expect(isDocsPagePath("/v/My/.vaultcore/docs.md")).toBe(false);
  });

  it("docsTabLabel is a fixed string", () => {
    expect(docsTabLabel("/v/MyVault/.vaultcore/DOCS.md")).toBe("Docs");
    expect(docsTabLabel("whatever")).toBe("Docs");
  });
});
