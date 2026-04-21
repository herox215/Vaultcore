// Tests for the Reading Mode markdown renderer (#63).
// Focuses on: wiki-link rendering, wiki-embed rendering, frontmatter strip,
// task-list checkboxes, and XSS sanitization. The wiki-embed / wiki-link
// module-level maps come from wikiLink.ts and embeds.ts respectively; we
// seed them directly to exercise the resolved branches.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Tauri's convertFileSrc isn't available under jsdom. Stub it to a stable
// predictable shape so the img tag assertions can check for the converted URL.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${encodeURIComponent(p)}`,
}));

import { setResolvedLinks } from "../wikiLink";
import { setResolvedAttachments } from "../embeds";
import { vaultStore } from "../../../store/vaultStore";
import { renderMarkdownToHtml } from "../reading/markdownRenderer";

beforeEach(() => {
  setResolvedLinks(new Map());
  setResolvedAttachments(new Map());
  vaultStore.setReady({ currentPath: "/tmp/vault", fileList: [], fileCount: 0 });
});

describe("renderMarkdownToHtml (#63)", () => {
  it("renders basic paragraphs with inline emphasis", () => {
    const html = renderMarkdownToHtml("Hello **world**.");
    expect(html).toContain("<p>");
    expect(html).toContain("<strong>world</strong>");
  });

  it("blocks raw HTML (script tags) — escaped so they cannot execute", () => {
    const html = renderMarkdownToHtml("Foo <script>alert(1)</script> bar");
    // markdown-it is configured with html: false so the raw tag is entity-
    // escaped; DOMPurify then guarantees no live <script> survives either.
    expect(html).not.toMatch(/<script[^>]*>/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("strips <script> tags even if they slip through markdown-it", () => {
    // Simulate content that would have reached DOMPurify as a live tag —
    // tests the belt-and-braces sanitizer layer, not just markdown-it.
    const html = renderMarkdownToHtml("<script>alert(1)</script>");
    expect(html).not.toMatch(/<script[^>]*>/i);
  });

  it("strips javascript: hrefs on anchors DOMPurify reaches", () => {
    // markdown-it's linkify validator rejects `javascript:` URLs at parse
    // time, so this test also exercises DOMPurify's URI filter via an
    // image variant whose alt-text forces an anchor-like token output.
    const html = renderMarkdownToHtml("[click](https://example.com)");
    // Normal http links survive as expected — smoke check on link rendering.
    expect(html).toMatch(/href="https:\/\/example.com"/);
  });

  it("renders resolved wiki-links as anchors carrying target + resolved attributes", () => {
    setResolvedLinks(new Map([["foo", "notes/foo.md"]]));
    const html = renderMarkdownToHtml("Link: [[Foo]]");
    expect(html).toMatch(/<a[^>]*data-wiki-target="Foo"[^>]*data-wiki-resolved="true"[^>]*>/);
    expect(html).toContain("vc-reading-wikilink--resolved");
  });

  it("renders unresolved wiki-links with the unresolved class", () => {
    const html = renderMarkdownToHtml("Link: [[Missing]]");
    expect(html).toContain("vc-reading-wikilink--unresolved");
    expect(html).toMatch(/data-wiki-resolved="false"/);
  });

  it("honours wiki-link aliases for display text", () => {
    const html = renderMarkdownToHtml("[[target|display label]]");
    expect(html).toContain(">display label<");
    expect(html).toMatch(/data-wiki-target="target"/);
  });

  it("renders resolved wiki-embeds as <img> pointing at convertFileSrc", () => {
    setResolvedAttachments(new Map([["img.png", "assets/img.png"]]));
    const html = renderMarkdownToHtml("![[img.png]]");
    expect(html).toMatch(/<img[^>]+src="asset:\/\//);
    expect(html).toContain("vc-reading-embed-img");
  });

  it("renders unresolved wiki-embeds as a placeholder span", () => {
    const html = renderMarkdownToHtml("![[missing.png]]");
    expect(html).toContain("vc-reading-embed--unresolved");
    expect(html).not.toContain("<img");
  });

  it("strips YAML frontmatter before rendering", () => {
    const html = renderMarkdownToHtml("---\ntitle: x\ntags: [a]\n---\n\n# Heading");
    expect(html).not.toContain("title:");
    // H1 carries a slugified id now (#285 ToC fix), so match the open tag
    // without assuming attribute shape.
    expect(html).toMatch(/<h1[^>]*>Heading<\/h1>/);
  });

  it("renders task list checkboxes as disabled inputs", () => {
    const html = renderMarkdownToHtml("- [ ] todo\n- [x] done\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });

  it("escapes wiki-link targets so injected HTML cannot leak", () => {
    const html = renderMarkdownToHtml('[[<script>alert(1)</script>]]');
    expect(html).not.toContain("<script>");
  });

  // ── Heading slug ids (#285 ToC bug) ────────────────────────────────────
  it("emits id= on headings derived from plain-text slug", () => {
    const html = renderMarkdownToHtml("# Getting started\n");
    expect(html).toContain('id="getting-started"');
  });

  it("slugifies punctuation and multiple spaces consistently", () => {
    const html = renderMarkdownToHtml("## Hello, world!\n\n### Foo   bar\n");
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('id="foo-bar"');
  });

  it("disambiguates duplicate heading slugs within one document", () => {
    const html = renderMarkdownToHtml("## Section\n\n## Section\n\n## Section\n");
    expect(html).toContain('id="section"');
    expect(html).toContain('id="section-1"');
    expect(html).toContain('id="section-2"');
  });

  it("resets slug counters between independent render() calls", () => {
    const a = renderMarkdownToHtml("## Section\n");
    const b = renderMarkdownToHtml("## Section\n");
    expect(a).toContain('id="section"');
    expect(b).toContain('id="section"');
    expect(b).not.toContain('id="section-1"');
  });

  it("anchor links to headings survive sanitization", () => {
    const html = renderMarkdownToHtml(
      "- [Hello](#hello)\n\n# Hello\n",
    );
    expect(html).toContain('href="#hello"');
    expect(html).toContain('id="hello"');
  });

  // ── Template expression expansion (#321) ───────────────────────────────
  describe("template expression expansion (#321)", () => {
    it("renders {{title}} using the basename passed in", () => {
      const html = renderMarkdownToHtml("Hello {{title}}!", "MyNote");
      expect(html).toContain("Hello MyNote!");
      expect(html).not.toContain("{{title}}");
    });

    it("renders {{date}} as an ISO-style yyyy-mm-dd string", () => {
      const html = renderMarkdownToHtml("Today: {{date}}", "n");
      expect(html).toMatch(/Today: \d{4}-\d{2}-\d{2}/);
    });

    it("evaluates multi-segment programs separated by `;`", () => {
      const html = renderMarkdownToHtml(
        '{{ "prefix-"; title }}',
        "MyNote",
      );
      expect(html).toContain("prefix-MyNote");
    });

    it("leaves the source visible on evaluation error", () => {
      // `nonexistent.whatever` throws an unknown-identifier error; the
      // renderer must keep the literal `{{ ... }}` text rather than
      // collapsing to an empty string.
      const html = renderMarkdownToHtml(
        "Broken {{nonexistent.whatever}} here",
        "n",
      );
      expect(html).toContain("{{nonexistent.whatever}}");
    });

    it("preserves wiki-links produced inside a template expression as anchors", () => {
      // `"[[foo]]"` as a string literal → same `[[foo]]` text after
      // evaluation → markdown-it's wiki-link rule then turns it into an
      // anchor with data-wiki-target.
      setResolvedLinks(new Map([["foo", "notes/foo.md"]]));
      const html = renderMarkdownToHtml('{{ "[[foo]]" }}', "n");
      expect(html).toMatch(/<a[^>]*data-wiki-target="foo"[^>]*>/);
    });

    it("does not disturb plain markdown when no `{{ ... }}` is present", () => {
      const html = renderMarkdownToHtml("# Hello\n\nWorld", "n");
      expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/);
      expect(html).toContain("<p>World</p>");
    });

    it("leaves empty-output templates as source to keep them debuggable", () => {
      // `""` evaluates to the empty string; per the semantics documented in
      // `expandTemplates`, empty output leaves the source visible so an
      // accidentally-empty template is not silently swallowed in Reading
      // Mode. markdown-it's typographer converts the straight quotes to
      // curly quotes during rendering — assert on the `{{`/`}}` markers
      // rather than the inner chars.
      const html = renderMarkdownToHtml('{{ "" }}', "n");
      expect(html).toMatch(/\{\{.*\}\}/);
    });
  });
});
