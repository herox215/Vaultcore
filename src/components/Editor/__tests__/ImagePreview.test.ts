// Component test for ImagePreview (#49). Asserts the rendered <img> uses
// convertFileSrc(absPath), so the asset:// protocol pipeline that already
// powers inline `![[image.png]]` embeds is reused for standalone preview tabs.

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/core", () => ({
  // Mirror the stable convertFileSrc shape: returns a `asset://` URL string
  // derived from the absolute path. The exact prefix doesn't matter; the
  // test asserts the *transformed* string ends up in the <img src> attribute.
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import ImagePreview from "../ImagePreview.svelte";

describe("ImagePreview", () => {
  it("renders an <img> whose src is convertFileSrc(abs)", () => {
    const abs = "/vault/photos/cat.png";
    const { container } = render(ImagePreview, { props: { abs } });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(
      `asset://localhost/${encodeURIComponent(abs)}`,
    );
  });

  it("uses the filename (with extension) as the alt text", () => {
    const { container } = render(ImagePreview, {
      props: { abs: "/v/sub/photo.JPEG" },
    });
    const img = container.querySelector("img");
    expect(img!.getAttribute("alt")).toBe("photo.JPEG");
  });

  it("uses the full path as alt when the path has no slash", () => {
    const { container } = render(ImagePreview, { props: { abs: "single.png" } });
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("single.png");
  });
});
