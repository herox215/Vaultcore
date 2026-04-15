// Unit tests for the active-tab → tree reveal resolver (#50).

import { describe, it, expect } from "vitest";
import { resolveRevealRelPath } from "../activeTabReveal";
import { GRAPH_TAB_PATH, type Tab } from "../../store/tabStore";

function tab(overrides: Partial<Tab> & Pick<Tab, "filePath">): Tab {
  return {
    id: "t1",
    isDirty: false,
    scrollPos: 0,
    cursorPos: 0,
    lastSaved: 0,
    lastSavedContent: "",
    ...overrides,
  };
}

describe("resolveRevealRelPath (#50)", () => {
  it("returns null when there is no active tab", () => {
    expect(resolveRevealRelPath(null, "/vault")).toBeNull();
    expect(resolveRevealRelPath(undefined, "/vault")).toBeNull();
  });

  it("returns null when the vault path is null", () => {
    expect(resolveRevealRelPath(tab({ filePath: "/vault/notes/a.md" }), null)).toBeNull();
  });

  it("returns null for graph tabs via type discriminant", () => {
    expect(
      resolveRevealRelPath(
        tab({ filePath: GRAPH_TAB_PATH, type: "graph" }),
        "/vault",
      ),
    ).toBeNull();
  });

  it("returns null for graph tabs even if only the sentinel path is set", () => {
    expect(
      resolveRevealRelPath(tab({ filePath: GRAPH_TAB_PATH }), "/vault"),
    ).toBeNull();
  });

  it("returns null when the tab's file lives outside the vault", () => {
    expect(
      resolveRevealRelPath(tab({ filePath: "/other/foo.md" }), "/vault"),
    ).toBeNull();
  });

  it("returns the vault-relative path for a top-level file", () => {
    expect(
      resolveRevealRelPath(tab({ filePath: "/vault/foo.md" }), "/vault"),
    ).toBe("foo.md");
  });

  it("returns the vault-relative path for a nested file", () => {
    expect(
      resolveRevealRelPath(
        tab({ filePath: "/vault/notes/daily/today.md" }),
        "/vault",
      ),
    ).toBe("notes/daily/today.md");
  });

  it("returns rel paths for non-markdown viewer tabs too", () => {
    expect(
      resolveRevealRelPath(
        tab({ filePath: "/vault/images/logo.png", viewer: "image" }),
        "/vault",
      ),
    ).toBe("images/logo.png");
  });

  it("strips trailing slashes from the vault path before comparing", () => {
    expect(
      resolveRevealRelPath(
        tab({ filePath: "/vault/notes/a.md" }),
        "/vault/",
      ),
    ).toBe("notes/a.md");
  });

  it("normalises backslashes to forward slashes in the tab's absolute path", () => {
    // The vault path is forward-slash form; backslash separators in the
    // tab's absolute path (defensive on Windows-shaped inputs) should
    // still match.
    expect(
      resolveRevealRelPath(
        tab({ filePath: "/vault\\notes\\a.md" }),
        "/vault",
      ),
    ).toBe("notes/a.md");
  });

  it("returns null for a file whose absolute path equals the vault itself", () => {
    expect(
      resolveRevealRelPath(tab({ filePath: "/vault" }), "/vault"),
    ).toBeNull();
  });
});
