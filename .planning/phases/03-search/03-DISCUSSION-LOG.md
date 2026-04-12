# Phase 3: Search - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-12
**Phase:** 03-search
**Areas discussed:** Such-Panel Layout, Quick Switcher UX, Ergebnis-Interaktion, Index-Rebuild Erlebnis

---

## Such-Panel Layout

### Wo soll das Volltextsuche-Panel erscheinen?

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar-Panel (Empfohlen) | Obsidian-Stil: Suche ersetzt den Dateibaum in der linken Sidebar. Ergebnisliste scrollbar, Sidebar-Breite bleibt. | :heavy_check_mark: |
| Dediziertes Panel unten | VS-Code-Stil: Such-Panel unterhalb des Editors, eigener Bereich. | |
| Zentriertes Modal | Spotlight-Stil: Modal in der Bildschirmmitte. | |

**User's choice:** Sidebar-Panel (Empfohlen)
**Notes:** None

### Wie sollen die Suchergebnisse dargestellt werden?

| Option | Description | Selected |
|--------|-------------|----------|
| Datei + Snippet (Empfohlen) | Dateiname + 1-2 Zeilen Kontext-Snippet mit hervorgehobenem Suchbegriff. Ergebniszahler oben. | :heavy_check_mark: |
| Gruppiert nach Datei | Dateiname als aufklappbare Gruppe, alle Treffer darunter. | |
| Nur Dateinamen | Minimalistisch: nur Dateinamen mit Trefferzahl. | |

**User's choice:** Datei + Snippet (Empfohlen)
**Notes:** None

### Live-Suche oder bei Enter?

| Option | Description | Selected |
|--------|-------------|----------|
| Live mit Debounce (Empfohlen) | Ergebnisse aktualisieren automatisch ~200ms nach letztem Tastendruck. | :heavy_check_mark: |
| Nur bei Enter | Suche startet erst bei Enter-Taste. | |

**User's choice:** Live mit Debounce (Empfohlen)
**Notes:** None

### Umschaltung Dateibaum / Such-Panel

| Option | Description | Selected |
|--------|-------------|----------|
| Tab-Leiste oben (Empfohlen) | Zwei Tabs: "Dateien" und "Suche". Cmd/Ctrl+Shift+F wechselt zum Such-Tab. | :heavy_check_mark: |
| Icon-Leiste seitlich | VS-Code Activity Bar mit Icons. | |
| Claude entscheidet | Claude wahlt basierend auf bestehendem Layout. | |

**User's choice:** Tab-Leiste oben (Empfohlen)
**Notes:** None

---

## Quick Switcher UX

### Wie soll der Quick Switcher aussehen?

| Option | Description | Selected |
|--------|-------------|----------|
| Obsidian-Stil (Empfohlen) | Zentriertes Modal, oberes Drittel. Suchfeld + scrollbare Ergebnisliste mit Dateiname + Pfad. | :heavy_check_mark: |
| Spotlight-Stil | Schmalerer schwebender Suchbalken. Nur Dateinamen. | |
| Claude entscheidet | Claude wahlt passend zum UI. | |

**User's choice:** Obsidian-Stil (Empfohlen)
**Notes:** None

### Vorschlage beim Offnen

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, Recent Files (Empfohlen) | Beim Offnen sofort zuletzt geoffnete Dateien anzeigen. | :heavy_check_mark: |
| Leer bis getippt wird | Leere Liste bis Eingabe. | |
| Claude entscheidet | Implementierungsdetail. | |

**User's choice:** Ja, Recent Files (Empfohlen)
**Notes:** None

### Fuzzy-Match-Strategie

| Option | Description | Selected |
|--------|-------------|----------|
| Substring + Initialen (Empfohlen) | Matched Teilstrings und Wortanfange. "mn" findet "meeting-notes.md". | :heavy_check_mark: |
| Nur Substring | Einfacher Substring-Match. | |
| Claude entscheidet | Claude wahlt Bibliothek und Strategie. | |

**User's choice:** Substring + Initialen (Empfohlen)
**Notes:** None

---

## Ergebnis-Interaktion

### An der Match-Stelle offnen (SRCH-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Scroll + Flash-Highlight (Empfohlen) | Offnet Datei, scrollt zur Stelle, 2-3s gelber Flash auf Suchbegriff. | :heavy_check_mark: |
| Scroll + Cursor | Cursor an Stelle, kein Highlighting. | |
| Scroll + dauerhaftes Highlight | Alle Vorkommen dauerhaft hervorgehoben. | |

**User's choice:** Scroll + Flash-Highlight
**Notes:** User commented that "Fundstelle" sounds terrible in German ("das klingt ja vollig scheisse") — noted for UI copy

### Tab-Verhalten bei Ergebnis-Klick

| Option | Description | Selected |
|--------|-------------|----------|
| Neuer Tab (Empfohlen) | Neuer Tab oder Wechsel zu bestehendem Tab. Obsidian-Verhalten. | :heavy_check_mark: |
| Preview-Tab | VS-Code-Stil kursiver Preview-Tab. | |
| Claude entscheidet | Claude wahlt basierend auf tabStore-Architektur. | |

**User's choice:** Neuer Tab (Empfohlen)
**Notes:** None

### Ergebnis-Limit

| Option | Description | Selected |
|--------|-------------|----------|
| Max 100 Dateien + Hinweis (Empfohlen) | 100 Ergebnis-Dateien max. Hinweis bei mehr Treffern. | :heavy_check_mark: |
| Alle Ergebnisse zeigen | Keine Grenze, virtualisierte Liste. | |
| Claude entscheidet | Claude wahlt sinnvolles Limit. | |

**User's choice:** Max 100 Dateien + Hinweis (Empfohlen)
**Notes:** None

---

## Index-Rebuild Erlebnis

### Automatischer Rebuild Kommunikation

| Option | Description | Selected |
|--------|-------------|----------|
| ProgressBar + Toast (Empfohlen) | Toast "Index wird neu aufgebaut..." + ProgressBar. Suche deaktiviert. Abschluss-Toast. | :heavy_check_mark: |
| Nur ProgressBar, kein Toast | Stiller Rebuild, nur ProgressBar. | |
| Vollbild-Overlay | Modales Overlay, blockiert App. | |

**User's choice:** ProgressBar + Toast (Empfohlen)
**Notes:** None

### Manueller Rebuild-Trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Im Such-Panel (Empfohlen) | Button im Such-Panel-Header. Kontextuell sinnvoll. | :heavy_check_mark: |
| Rechtsklick-Menu im Dateibaum | Rechtsklick auf Vault-Root. | |
| Claude entscheidet | Claude platziert Trigger optimal. | |

**User's choice:** Im Such-Panel (Empfohlen)
**Notes:** None

### Editierbarkeit wahrend Rebuild

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, Editor bleibt aktiv (Empfohlen) | Editor + Dateibaum funktionieren normal. Nur Suche deaktiviert. | :heavy_check_mark: |
| Alles blockiert | Kein Editieren bis Rebuild fertig. | |

**User's choice:** Ja, Editor bleibt aktiv (Empfohlen)
**Notes:** None

---

## Claude's Discretion

- Tantivy schema design (fields, tokenizer, snippet generation)
- Fuzzy matcher library choice
- Quick Switcher result limits
- Search syntax help display
- Central queue implementation details
- index_version.json schema
- SHA-256 caching strategy
- Tab-leiste visual styling
- Flash-highlight CSS/animation details

## Deferred Ideas

None — discussion stayed within phase scope.
