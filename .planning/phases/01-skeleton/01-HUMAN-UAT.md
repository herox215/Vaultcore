---
status: partial
phase: 01-skeleton
source: [01-VERIFICATION.md]
started: 2026-04-12T00:00:00Z
updated: 2026-04-12T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Launch app and verify Welcome screen
expected: Centered card with VaultCore heading, tagline, "Open vault" CTA, divider, RECENT VAULTS label, empty state text
result: [pending]

### 2. Open vault via native folder dialog
expected: Native OS folder picker opens; on selection, progress overlay shows file count, then vault view with file list and vault path in header
result: [pending]

### 3. Auto-load on relaunch + recent list persistence
expected: App auto-loads last vault without showing Welcome; on reset, recent list shows the previously opened vault path
result: [pending]

### 4. CM6 editor rendering with Markdown highlighting
expected: Editor mounts with styled headings (H1=26px, H2=22px, H3=18px), bold/italic rendering, inline code background, GFM support
result: [pending]

### 5. Auto-save to disk + keyboard shortcuts
expected: File on disk reflects edits after ~2s idle; Cmd/Ctrl+B wraps **bold**, I wraps *italic*, K inserts [text](url); toggle-off works
result: [pending]

### 6. Unreachable vault fallback
expected: App shows Welcome screen (not crash); toast appears with VaultUnavailable message
result: [pending]

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps
