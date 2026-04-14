// Shape-level tests for the graphRender helpers. We deliberately avoid
// exercising sigma's WebGL renderer here — jsdom has no WebGL context and
// mocking it out completely adds more weight than it saves. Instead we test
// the pure helpers exposed from graphRender.ts (`applyAlpha`) plus verify
// that the public API has the expected surface.
//
// The full mount/update/destroy dance is covered by the Rust-side BFS tests
// that feed the renderer and by manual verification in the PR.
//
// `sigma` references `WebGL2RenderingContext.BOOL` at import time which jsdom
// doesn't define, so we stub the module before importing graphRender.

import { describe, expect, it, vi } from "vitest";

vi.mock("sigma", () => {
  class SigmaStub {
    on() {}
    setSetting() {}
    refresh() {}
    kill() {}
  }
  return { default: SigmaStub };
});

vi.mock("graphology-layout-forceatlas2", () => {
  return {
    default: {
      inferSettings: () => ({}),
      assign: () => undefined,
    },
  };
});

import { applyAlpha } from "../graphRender";

describe("applyAlpha", () => {
  it("converts #rrggbb to rgba()", () => {
    expect(applyAlpha("#ff8800", 0.2)).toBe("rgba(255, 136, 0, 0.2)");
  });

  it("expands #rgb to #rrggbb then rgba()", () => {
    expect(applyAlpha("#f80", 0.5)).toBe("rgba(255, 136, 0, 0.5)");
  });

  it("rewrites rgb()/rgba() to a new alpha", () => {
    expect(applyAlpha("rgb(10, 20, 30)", 0.4)).toBe("rgba(10, 20, 30, 0.4)");
    expect(applyAlpha("rgba(10, 20, 30, 0.9)", 0.1)).toBe(
      "rgba(10, 20, 30, 0.1)",
    );
  });

  it("leaves unknown formats unchanged", () => {
    expect(applyAlpha("currentColor", 0.3)).toBe("currentColor");
    expect(applyAlpha("#nothex", 0.3)).toBe("#nothex");
  });
});

describe("graphRender public API", () => {
  it("exports mountGraph / updateGraph / destroyGraph / setCenter", async () => {
    const mod = await import("../graphRender");
    expect(typeof mod.mountGraph).toBe("function");
    expect(typeof mod.updateGraph).toBe("function");
    expect(typeof mod.destroyGraph).toBe("function");
    expect(typeof mod.setCenter).toBe("function");
  });
});
