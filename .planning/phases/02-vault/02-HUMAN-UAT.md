---
status: partial
phase: 02-vault
source: [02-VERIFICATION.md]
started: 2026-04-12T12:30:00Z
updated: 2026-04-12T12:30:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Sidebar tree navigation
expected: Folder-first sort, dot-dirs absent, subtrees load only on expand.
result: [pending]

### 2. File operations (create, rename, delete, move) with CR-01/CR-02 fixes
expected: All four file operations functional. Rename prompt shows link count (CR-01 fix). Sidebar refreshes after rename (CR-02 fix).
result: [pending]

### 3. Multi-tab and split view
expected: Tabs cycle with Cmd/Ctrl+Tab, close with Cmd/Ctrl+W/middle-click, drag-to-split creates 2-pane editor.
result: [pending]

### 4. External edit merge with German toast
expected: Toast: "Externe Anderungen wurden in <filename> eingebunden." (German per SC#4).
result: [pending]

### 5. Conflict resolution with German toast
expected: Toast: "Konflikt in <filename> - lokale Version behalten." Local content preserved.
result: [pending]

### 6. Self-write non-triggering
expected: Auto-save writes silently filtered. No external-change toast appears.
result: [pending]

### 7. Vault unmount/reconnect handling
expected: Readonly overlay on unmount, re-enabled on reconnect.
result: [pending]

## Summary

total: 7
passed: 0
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps
