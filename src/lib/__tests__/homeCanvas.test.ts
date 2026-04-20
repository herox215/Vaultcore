// Unit tests for the home-canvas path helpers (#279).

import { describe, it, expect } from "vitest";
import {
  HOME_CANVAS_REL,
  homeCanvasPath,
  isHomeCanvasPath,
  homeTabLabel,
} from "../homeCanvas";

describe("homeCanvas helpers", () => {
  it("HOME_CANVAS_REL sits inside .vaultcore/", () => {
    expect(HOME_CANVAS_REL).toBe(".vaultcore/home.canvas");
  });

  it("homeCanvasPath joins vault + relative with forward slash", () => {
    expect(homeCanvasPath("/Users/x/MyVault")).toBe(
      "/Users/x/MyVault/.vaultcore/home.canvas",
    );
  });

  it("homeCanvasPath normalises Windows-style backslashes", () => {
    expect(homeCanvasPath("C:\\vaults\\Notes")).toBe(
      "C:/vaults/Notes/.vaultcore/home.canvas",
    );
  });

  it("isHomeCanvasPath matches the exact suffix", () => {
    expect(isHomeCanvasPath("/v/My/.vaultcore/home.canvas")).toBe(true);
    expect(isHomeCanvasPath("C:\\v\\My\\.vaultcore\\home.canvas")).toBe(true);
  });

  it("isHomeCanvasPath rejects unrelated paths", () => {
    expect(isHomeCanvasPath("/v/My/home.canvas")).toBe(false);
    expect(isHomeCanvasPath("/v/My/.vaultcore/other.canvas")).toBe(false);
    expect(isHomeCanvasPath("/v/My/note.md")).toBe(false);
  });

  it("homeTabLabel returns the vault directory name", () => {
    expect(homeTabLabel("/Users/x/MyVault/.vaultcore/home.canvas")).toBe(
      "MyVault",
    );
    expect(homeTabLabel("C:\\vaults\\Notes\\.vaultcore\\home.canvas")).toBe(
      "Notes",
    );
  });

  it("homeTabLabel falls back to 'Home' for malformed input", () => {
    expect(homeTabLabel("nonsense")).toBe("Home");
  });
});
