# Phase 2: Vault - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-12
**Phase:** 02-vault
**Areas discussed:** Sidebar-Tree Verhalten, Multi-Tab + Split-View, File-Watcher + Merge, Datei-Operationen

---

## Sidebar-Tree Verhalten

| Option | Description | Selected |
|--------|-------------|----------|
| Lazy (Empfohlen) | Nur Root-Ebene initial, Unterordner erst bei Aufklappen laden | ✓ |
| Full pre-load | Ganzen Baum beim Vault-Open laden und im Memory halten | |
| Hybrid | Erste 2 Ebenen sofort laden, tiefere lazy | |

**User's choice:** Lazy
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Links, resizable (Obsidian-Style) | Standard-Position, Drag-Handle zum Resize, Breite persistiert | ✓ |
| Links, fixed 260px | Kein Resize-Handle | |
| Du entscheidest | | |

**User's choice:** Links, resizable (Obsidian-Style)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Ordner zuerst, dann alphabetisch | Standard-Konvention (VS Code, Obsidian) | ✓ |
| Rein alphabetisch gemischt | | |
| Du entscheidest | | |

**User's choice:** Ordner zuerst, dann alphabetisch
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Alle dot-Ordner verstecken | Alles was mit . anfängt wird im Tree nicht gezeigt | ✓ |
| Nur .obsidian/ verstecken | | |
| .obsidian/ + .trash/ verstecken | | |

**User's choice:** Alle dot-Ordner verstecken
**Notes:** None

---

## Multi-Tab + Split-View

| Option | Description | Selected |
|--------|-------------|----------|
| Obsidian-Style (Empfohlen) | Tabs oben, Drag-to-Reorder, Mittelklick/X schließt, Dot-Indikator | ✓ |
| Minimal (kein Reorder) | Tabs oben, aber kein Drag-Reorder | |
| Du entscheidest | | |

**User's choice:** Obsidian-Style
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Drag Tab an den Rand (Obsidian-Style) | Tab an linken/rechten Rand des Editors ziehen → Split | ✓ |
| Rechtsklick → 'Im Split öffnen' | Kontextmenü-Aktion | |
| Beides | Drag + Kontextmenü | |
| Du entscheidest | | |

**User's choice:** Drag Tab an den Rand (Obsidian-Style)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Neuer tabStore (Empfohlen) | Dedizierter tabStore mit Tab-Array, activeTabId, Split-State | ✓ |
| editorStore erweitern | editorStore bekommt tabs-Array | |
| Du entscheidest | | |

**User's choice:** Neuer tabStore
**Notes:** None

---

## File-Watcher + Merge

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-merge, bei Konflikt lokal behalten (Empfohlen) | Externer Change automatisch eingebunden, bei Konflikt lokal behalten | ✓ |
| Immer lokal behalten | Externe Änderungen ignorieren bis Tab geschlossen | |
| Dialog bei Konflikt | Modal-Dialog mit Diff-Ansicht | |

**User's choice:** Auto-merge, bei Konflikt lokal behalten
**Notes:** Toast text per Success Criteria: "Externe Änderungen wurden eingebunden" / "Konflikt in <file> – lokale Version behalten"

| Option | Description | Selected |
|--------|-------------|----------|
| Write-Token + Zeitfenster (Empfohlen) | Token/Timestamp vor Write, Watcher ignoriert Events innerhalb ~100ms | ✓ |
| Globales Write-Lock | Watcher komplett pausieren während Auto-Save | |
| Du entscheidest | | |

**User's choice:** Write-Token + Zeitfenster
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| 500 Events in 2s (wie Success Criteria) | Per ROADMAP >500 Dateien, Sliding Window | ✓ |
| 100 Events in 1s | Niedrigere Schwelle | |
| Du entscheidest | | |

**User's choice:** 500 Events in 2s
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Editing deaktivieren + Toast (wie Spec) | Editor readonly, Buffer im Memory, Reconnect-Versuch | ✓ |
| Zurück zum Welcome-Screen | Vault schließen, Tabs zu | |
| Du entscheidest | | |

**User's choice:** Editing deaktivieren + Toast
**Notes:** Per ERR-03 requirement

---

## Datei-Operationen

| Option | Description | Selected |
|--------|-------------|----------|
| .trash/ im Vault (Obsidian-Style) | Gelöschte Dateien in .trash/ innerhalb des Vaults | ✓ |
| System-Papierkorb | OS-Papierkorb via Tauri trash API | |
| Du entscheidest | | |

**User's choice:** .trash/ im Vault (Obsidian-Style)
**Notes:** .trash/ hidden per dot-directory rule

| Option | Description | Selected |
|--------|-------------|----------|
| Einfacher Count-Prompt (Empfohlen) | "X Wiki-Links verweisen auf diese Datei" mit Count, keine Liste | ✓ |
| Liste der betroffenen Dateien | Prompt zeigt welche Dateien Links haben | |
| Kein Prompt, einfach umbenennen | Keine Warnung | |

**User's choice:** Einfacher Count-Prompt
**Notes:** Simple regex scan, Phase 4 adds real link parser

| Option | Description | Selected |
|--------|-------------|----------|
| Move (Obsidian-Style) | Drag-Drop verschiebt, kein Copy | ✓ |
| Du entscheidest | | |

**User's choice:** Move (Obsidian-Style)
**Notes:** Alt+Drag copy deferred to Phase 5

| Option | Description | Selected |
|--------|-------------|----------|
| Im aktuell ausgewählten Ordner | Rechtsklick → Neue Datei, Unbenannt.md, inline rename | ✓ |
| Immer im Vault-Root | | |
| Du entscheidest | | |

**User's choice:** Im aktuell ausgewählten Ordner
**Notes:** Auto-suffix on collision (Unbenannt 1.md, etc.)

---

## Claude's Discretion

- Sidebar visual details (icons, hover states, animation)
- Tab bar visual details (max-width, truncation, close-button visibility)
- Split-view resize (draggable vs. fixed 50/50)
- Watcher debounce tuning (~200ms suggested)
- Three-way merge algorithm specifics
- Inline rename UX details

## Deferred Ideas

- Show hidden files toggle (Phase 5)
- Tab session restore (Phase 5)
- Alt+Drag = Copy (Phase 5)
- Vertical split / grid layout (Phase 5+)
- Trash management UI (Phase 5)
