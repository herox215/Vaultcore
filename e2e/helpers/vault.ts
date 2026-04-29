import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface TestVault {
  path: string;
  cleanup: () => void;
}

const FIXTURES: Record<string, string> = {
  "Welcome.md": `# Welcome to the test vault

This is the **welcome note** for the E2E test vault.

See also [[Daily Log]] and [[Ideas]].
`,

  "Daily Log.md": `# Daily Log

Today I worked on the E2E tests.

Links: [[Welcome]] | [[Ideas]]

#journal #daily
`,

  "Ideas.md": `# Ideas

- Build a local-first knowledge base
- Use [[Wiki Links]] everywhere
- Check the [[Daily Log]] for progress

#ideas #brainstorm
`,

  "Wiki Links.md": `# Wiki Links

Wiki links look like this: [[Welcome]]

They connect notes in a bidirectional graph.
`,

  "subfolder/Nested Note.md": `# Nested Note

This note lives inside a subfolder.

See [[Welcome]] for the main page.
`,

  "subfolder/Another Note.md": `# Another Note

A second file in the subfolder.

#subfolder
`,

  "attachments/placeholder.txt": `This directory holds attachments for the test vault.
`,

  "Tagged.md": `---
tags: [alpha, beta]
---
# Tagged
`,

  // ── #62: block + heading anchor fixtures ──────────────────────────────
  "Anchored.md": `# Anchored Source

## Quick Recap

This is the recap paragraph that the block-ref test scrolls to. ^recap

## Multi Word Heading

Body of the multi-word section. Slug is \`multi-word-heading\`.

### Nested H3 inside Multi Word

This nested heading sits inside the multi-word section embed.

## Düsseldorf trip

Unicode-slug section to exercise the parity fixture in a live test.

## Final section

Last section, embed runs to EOF.
`,

  "Anchor Refs.md": `# Anchor Refs

Block ref: [[Anchored^recap]]

Heading ref (multi-word slug): [[Anchored#Multi Word Heading]]

Anchor missing: [[Anchored^does-not-exist]]

Heading embed: ![[Anchored#Multi Word Heading]]

Block embed: ![[Anchored^recap]]
`,
};

export function createTestVault(): TestVault {
  const id = crypto.randomUUID();
  const vaultPath = path.join(os.tmpdir(), `e2e-vault-${id}`);

  for (const [relPath, content] of Object.entries(FIXTURES)) {
    const fullPath = path.join(vaultPath, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  return {
    path: vaultPath,
    cleanup() {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    },
  };
}
