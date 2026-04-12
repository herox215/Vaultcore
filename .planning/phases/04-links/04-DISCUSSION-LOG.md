# Phase 4: Links - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-12
**Phase:** 04-links
**Areas discussed:** Backlinks-Panel, Link-Autocomplete, Unresolved-Link Styling, Rename-Cascade UX

---

## Backlinks-Panel

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar-Tab | Dritter Tab neben "Dateien" und "Suche" in der linken Sidebar | |
| Unteres Editor-Panel | Klappt unter dem aktiven Editor auf, ähnlich wie Obsidian | |
| Rechte Seitenleiste | Eigene rechte Sidebar nur für Backlinks/Metadaten | ✓ |

**User's choice:** Rechte Seitenleiste
**Notes:** Separates Layout-Element, hält linke Sidebar für Dateien + Suche frei

| Option | Description | Selected |
|--------|-------------|----------|
| Toggle per Shortcut | Ein/Aus per Tastenkombination, standardmäßig geschlossen, Zustand gespeichert | ✓ |
| Immer sichtbar | Bei geöffnetem Vault immer sichtbar, per Drag zusammenschiebbar | |
| Auto + Toggle | Standardmäßig offen wenn Backlinks vorhanden, zusätzlich togglebar | |

**User's choice:** Toggle per Shortcut
**Notes:** Standardmäßig geschlossen, Zustand über Sessions gespeichert

| Option | Description | Selected |
|--------|-------------|----------|
| Dateiname + Kontext | Dateiname als Titel, 1-2 Zeilen Kontext um den Link herum, klickbar | ✓ |
| Nur Dateinamen | Kompakte Liste nur mit Dateinamen | |
| Gruppiert nach Ordner | Backlinks nach Ordnerstruktur gruppiert | |

**User's choice:** Dateiname + Kontext
**Notes:** Obsidian-ähnliche Darstellung

---

## Link-Autocomplete

| Option | Description | Selected |
|--------|-------------|----------|
| Dateiname + Pfad | Dateiname fett, relativer Pfad in grau darunter | ✓ |
| Nur Dateiname | Kompakt, nur Dateinamen | |
| Dateiname + Alias | Dateiname + erster H1-Titel als Alias | |

**User's choice:** Dateiname + Pfad
**Notes:** Hilft bei Namenskollisionen in großen Vaults

| Option | Description | Selected |
|--------|-------------|----------|
| Fuzzy-Match | Fuzzy-Matching über Dateinamen (nucleo), konsistent mit Quick Switcher | ✓ |
| Prefix-Match | Nur Dateinamen die mit dem getippten Text beginnen | |
| Substring-Match | Sucht den getippten Text irgendwo im Dateinamen | |

**User's choice:** Fuzzy-Match
**Notes:** Konsistent mit Cmd+P Quick Switcher, nucleo bereits integriert

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, mit Pipe-Erkennung | Nach Dateiauswahl kann \| getippt werden für Alias-Freitext | ✓ |
| Nur Dateiname | Popup fügt nur [[Dateiname]] ein, Alias manuell | |
| Du entscheidest | Claude wählt den pragmatischsten Ansatz | |

**User's choice:** Ja, mit Pipe-Erkennung
**Notes:** Obsidian-kompatibel, [[Note|alias]] Syntax unterstützt

---

## Unresolved-Link Styling

| Option | Description | Selected |
|--------|-------------|----------|
| Andere Farbe | Unresolved in grau/gedämpft, resolved in Akzentfarbe (blau/lila) | ✓ |
| Gestrichelte Unterstreichung | Farbe gleich, nur Unterstrich ändert sich | |
| Farbe + Tooltip | Andere Farbe + Tooltip "Notiz nicht gefunden" beim Hovern | |

**User's choice:** Andere Farbe
**Notes:** Dezent aber klar unterscheidbar, Obsidian-kompatibel

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, Notiz erstellen | Klick auf unresolved Link erstellt Datei und öffnet in neuem Tab | ✓ |
| Nein, nur Toast-Hinweis | Klick zeigt Toast "Notiz existiert nicht" | |
| Du entscheidest | Claude wählt basierend auf Obsidian-Kompatibilität | |

**User's choice:** Ja, Notiz erstellen
**Notes:** Obsidian-Verhalten, natürlicher Zettelkasten-Workflow

---

## Rename-Cascade UX

| Option | Description | Selected |
|--------|-------------|----------|
| Einfacher Dialog | "X Links werden aktualisiert. Fortfahren?" mit Ja/Nein | ✓ |
| Dialog mit Dateiliste | Zusätzlich betroffene Dateien als Liste im Dialog | |
| Automatisch ohne Dialog | Links ohne Nachfrage aktualisiert, Toast zeigt Ergebnis | |

**User's choice:** Einfacher Dialog
**Notes:** Nutzt bestehenden TreeNode Confirmation-Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Partial-Update + Toast | Erfolgreiche Links bleiben, Fehler per Toast gemeldet, kein Rollback | ✓ |
| Alles-oder-nichts Rollback | Bei Fehler alle Änderungen zurückrollen | |
| Du entscheidest | Claude wählt pragmatischsten MVP-Ansatz | |

**User's choice:** Partial-Update + Toast
**Notes:** Pragmatisch für MVP, kein komplexer Rollback nötig

| Option | Description | Selected |
|--------|-------------|----------|
| Beides | Rename und Move/Drag-and-Drop aktualisiert Wiki-Links | ✓ |
| Nur Umbenennen | Nur bei explizitem Rename, Move lässt Links unberührt | |
| Du entscheidest | Claude wählt basierend auf Spec (LINK-09) | |

**User's choice:** Beides
**Notes:** Move ändert kürzesten Pfad — Links müssen angepasst werden

---

## Claude's Discretion

- CM6 extension architecture for wiki-link parsing/decoration
- Link graph data structure and incremental update strategy
- Right sidebar width, resize behavior, animation
- `get_unresolved_links` command implementation

## Deferred Ideas

None — discussion stayed within phase scope
