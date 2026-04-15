// Component test for UnsupportedPreview (#49). Ensures we show a clean
// "cannot preview" state (AC: binary files show a clean placeholder rather
// than crashing / hanging / silently failing).

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import UnsupportedPreview from "../UnsupportedPreview.svelte";

describe("UnsupportedPreview", () => {
  it("renders the cannot-preview heading", () => {
    const { container } = render(UnsupportedPreview, {
      props: { abs: "/vault/archive.zip" },
    });
    expect(container.textContent).toContain("Cannot preview this file type");
  });

  it("shows the filename with its extension", () => {
    const { container } = render(UnsupportedPreview, {
      props: { abs: "/vault/sub/archive.zip" },
    });
    expect(container.textContent).toContain("archive.zip");
  });
});
