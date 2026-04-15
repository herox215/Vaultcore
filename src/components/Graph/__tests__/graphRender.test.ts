// Shape-level tests for the graphRender helpers. We deliberately avoid
// exercising sigma's WebGL renderer here — jsdom has no WebGL context and
// mocking it out completely adds more weight than it saves. Instead we test
// the pure helpers exposed from graphRender.ts (`applyAlpha`), verify the
// public API surface, and exercise the d3-force integration through a
// lightweight Sigma stub.
//
// The full mount/update/destroy dance is covered by the Rust-side BFS tests
// that feed the renderer and by manual verification in the PR.
//
// `sigma` references `WebGL2RenderingContext.BOOL` at import time which jsdom
// doesn't define, so we stub the module before importing graphRender.

import { describe, expect, it, vi } from "vitest";

vi.mock("sigma", () => {
  class CameraStub {
    disable() {}
    enable() {}
    on() {}
    removeListener() {}
    getState() {
      return { x: 0, y: 0, ratio: 1, angle: 0 };
    }
    setState() {}
    animatedReset() {}
  }
  class MouseCaptorStub {
    on() {}
    removeListener() {}
  }
  class SigmaStub {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private camera = new CameraStub();
    private mouseCaptor = new MouseCaptorStub();
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    setSetting() {}
    refresh() {}
    kill() {}
    getCamera() {
      return this.camera;
    }
    getMouseCaptor() {
      return this.mouseCaptor;
    }
    viewportToGraph(p: { x: number; y: number }) {
      return p;
    }
  }
  return { default: SigmaStub };
});

import {
  applyAlpha,
  DEFAULT_FORCE_SETTINGS,
  destroyGraph,
  mountGraph,
  setForceSettings,
  setLayoutFrozen,
  updateGraph,
} from "../graphRender";
import type { LocalGraph } from "../../../types/links";

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  return el;
}

function sampleGraph(): LocalGraph {
  return {
    nodes: [
      { id: "a.md", label: "A", path: "a.md", backlinkCount: 1, resolved: true },
      { id: "b.md", label: "B", path: "b.md", backlinkCount: 0, resolved: true },
      { id: "c.md", label: "C", path: "c.md", backlinkCount: 2, resolved: true },
    ],
    edges: [
      { from: "a.md", to: "b.md" },
      { from: "b.md", to: "c.md" },
    ],
  };
}

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
    expect(typeof mod.setForceSettings).toBe("function");
    expect(typeof mod.setLayoutFrozen).toBe("function");
  });
});

describe("d3-force integration", () => {
  it("mountGraph returns a handle with a non-null renderer and a simulation for non-degenerate graphs", () => {
    const handle = mountGraph(makeContainer(), sampleGraph(), {
      centerId: "a.md",
      accentColor: "#ff8800",
      nodeColor: "#888888",
      unresolvedColor: "#cccccc",
      edgeColor: "#eeeeee",
      forceSettings: DEFAULT_FORCE_SETTINGS,
    });
    expect(handle.renderer).not.toBeNull();
    expect(handle.simulation).not.toBeNull();
    expect(handle.simNodes.size).toBe(3);
    destroyGraph(handle);
  });

  it("setLayoutFrozen(true) stops the simulation", () => {
    const handle = mountGraph(makeContainer(), sampleGraph(), {
      centerId: "a.md",
      accentColor: "#ff8800",
      nodeColor: "#888888",
      unresolvedColor: "#cccccc",
      edgeColor: "#eeeeee",
      forceSettings: DEFAULT_FORCE_SETTINGS,
    });
    setLayoutFrozen(handle, true);
    expect(handle.frozen).toBe(true);
    // After stop() d3-force's alpha doesn't decay past alphaMin; sanity-check
    // it's still a finite small number and the internal timer is cleared by
    // asserting on the frozen mirror. (We can't introspect the timer.)
    expect(Number.isFinite(handle.simulation!.alpha())).toBe(true);
    destroyGraph(handle);
  });

  it("updateGraph with relayout=false preserves positions for nodes present in both datasets", () => {
    const handle = mountGraph(makeContainer(), sampleGraph(), {
      centerId: "a.md",
      accentColor: "#ff8800",
      nodeColor: "#888888",
      unresolvedColor: "#cccccc",
      edgeColor: "#eeeeee",
      forceSettings: DEFAULT_FORCE_SETTINGS,
    });
    // Manually set a known position on an existing node so we can detect
    // whether updateGraph preserved it. d3-force's own tick may have moved
    // the node, but setting after mount overrides both graphology and
    // simNodes coordinates.
    handle.graph.setNodeAttribute("a.md", "x", 42);
    handle.graph.setNodeAttribute("a.md", "y", -17);
    const simA = handle.simNodes.get("a.md")!;
    simA.x = 42;
    simA.y = -17;

    const nextData: LocalGraph = {
      nodes: [
        { id: "a.md", label: "A", path: "a.md", backlinkCount: 1, resolved: true },
        { id: "b.md", label: "B", path: "b.md", backlinkCount: 0, resolved: true },
        { id: "d.md", label: "D", path: "d.md", backlinkCount: 0, resolved: true },
      ],
      edges: [{ from: "a.md", to: "b.md" }],
    };
    updateGraph(handle, nextData, { relayout: false });

    expect(handle.graph.getNodeAttribute("a.md", "x")).toBe(42);
    expect(handle.graph.getNodeAttribute("a.md", "y")).toBe(-17);
    // New node gets seeded; carried-over SimNode kept its position.
    expect(handle.simNodes.get("a.md")!.x).toBe(42);
    expect(handle.simNodes.has("d.md")).toBe(true);
    destroyGraph(handle);
  });

  it("setForceSettings mutates the running simulation's forces without recreating it", () => {
    const handle = mountGraph(makeContainer(), sampleGraph(), {
      centerId: null,
      accentColor: "#ff8800",
      nodeColor: "#888888",
      unresolvedColor: "#cccccc",
      edgeColor: "#eeeeee",
      forceSettings: DEFAULT_FORCE_SETTINGS,
    });
    const before = handle.simulation;
    setForceSettings(handle, {
      ...DEFAULT_FORCE_SETTINGS,
      scalingRatio: 20,
      slowDown: 5,
    });
    expect(handle.simulation).toBe(before);
    expect(handle.options.forceSettings?.scalingRatio).toBe(20);
    destroyGraph(handle);
  });
});
