# Phase 6: Benchmark & Release - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-13
**Phase:** 06-benchmark-release
**Areas discussed:** Test-Vault-Generator
**Mode:** Interactive (kein --auto / --chain / --power)
**Response language:** Deutsch

---

## Gray-Area-Auswahl

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Test-Vault-Generator | Wie wird der 100k-Vault erzeugt (Stil, Determinismus, Bereitstellung, Edge-Cases) | ✓ |
| Benchmark-Harness & Frontend-Perf | Rust criterion? Frontend-Messung für Keystroke/Note-Open/Cold-Start? | |
| CI & Cross-Platform Build Pipeline | GitHub Actions Matrix, Runner-Wahl, Signing, Release-Distribution | |
| Security-Audit-Methodologie | cargo audit + Capability-Review + runtime syscall capture | |

**User-Auswahl:** Nur Test-Vault-Generator. Die anderen drei Bereiche sind bewusst der Claude's-Discretion-Sektion in CONTEXT.md überlassen und werden von Research/Planner entschieden.

---

## Test-Vault-Generator

### Wo und wie soll der Generator leben?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Rust-Binary im Repo (Recommended) | `[[bin]]`-Target im bestehenden `src-tauri/`, deterministisch via Seed, CI-trivial, wiederverwendet vorhandene Crates | ✓ |
| Separates Rust-Crate im Workspace | Neues `crates/vault-gen/` — sauberer, aber Workspace-Umbau nötig | |
| Node/TS-Skript | Konsistent mit Frontend-Tests, aber langsamer und duplisiert Logik | |
| Python-Skript | Schnell, aber neue Tool-Dependency (aktuell keine) | |

**User's choice:** Rust-Binary im Repo.
**Notes:** Minimale Umstrukturierung — Research entscheidet, ob `[[bin]]`-Target in `src-tauri/Cargo.toml` oder schmales Workspace-Crate.

---

### Welcher Content-Stil für die 100k Notes?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Markov-Chain aus Wortliste (Recommended) | Seed-basiert, realistische Tantivy-Tokens, ~500 Wörter/Datei | ✓ |
| Lorem ipsum | Einfachst, aber künstliches Ranking (alles matched alles) | |
| Echte OSS-Docs sampeln | Realistischste Tokens, aber externe Download-Abhängigkeit | |
| Syntax-reicher Mix | Hand-Templates mit Code/Tabellen/Listen — aufwendiger | |

**User's choice:** Markov-Chain.
**Notes:** Bilinguale Wortliste (DE + EN), im Repo eingecheckt, deterministisch.

---

### Wie dicht sollen Wiki-Links und Tags gesetzt werden?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Realistisch: 3-8 Links + 2-5 Tags pro Note (Recommended) | Pareto für Hub-Notes, stresst LinkGraph/Backlinks realistisch | ✓ |
| Spars: 1-3 Links, 0-2 Tags | Zu leicht — Budget könnte künstlich gewinnen | |
| Stress: 20+ Links + 10+ Tags | Worst-Case, aber kann Budgets künstlich blockieren | |
| Parametrisierbar, Default 'realistisch' | Flag-Flexibilität; implizit durch D-08 abgedeckt | |

**User's choice:** Realistisch.
**Notes:** Dichte-Flags bleiben optional (D-08), Default ist realistisch.

---

### Wie wird der generierte Vault aufbewahrt / bereitgestellt?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| On-demand in CI, mit Cache-Key (Recommended) | actions/cache, Seed+Config als Key, kein Repo-Bloat | ✓ |
| Git LFS / Submodule | Hunderte MB, lahmer Checkout, LFS-Kosten | |
| Kleiner Fixture (1k) im Repo + 100k in CI | Pragmatisch, aber zusätzliche Wartungslast | |
| External Release-Asset (GitHub Releases Tarball) | Null CI-Zeit, aber manuelle Regenerierung | |

**User's choice:** On-demand in CI mit Cache-Key.

---

### Dateigrößen-Verteilung im Test-Vault?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Gauss μ=500 σ=200 + ~10 Ausreißer mit 10k Zeilen (Recommended) | Spec-konform + EDIT-08-Regression kontinuierlich mitgeprüft | ✓ |
| Uniform fix 500 Wörter | Simpel, deckt EDIT-08 nicht ab | |
| Log-Normal mit langem Schwanz | Realistischste Verteilung, aber Benchmark-Varianz | |
| Parametrisierbar | Flexibel; durch optionale Flags abgedeckt | |

**User's choice:** Gauss + deterministische 10k-Zeilen-Outlier.

---

### Ordner-Struktur für den Vault?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Hierarchie mit Pareto-Verteilung (Recommended) | 3-5 Ebenen, Namens-Kollisionen, testet Tree-Lazy + 3-Stufen-Resolution | ✓ |
| Flach (alle 100k im Root) | Trivialisiert Tree-Loader und LINK-02 | |
| Gleichverteilung über 100 Ordner | Kein tiefer Baum, keine Hierarchie-Stresses | |

**User's choice:** Hierarchie mit Pareto.
**Notes:** Namens-Kollisionen explizit gewollt (mehrere `Index.md` an unterschiedlichen Pfaden).

---

### Welche Edge-Cases soll der Generator einbauen?

| Option | Beschreibung | Selected |
|--------|--------------|----------|
| Non-UTF-8-Dateien (IDX-08 / FILE-09) | Indexer-Skip + Tree-Display verifizieren | ✓ |
| Symlinks (FILE-08) | Angezeigt, nicht aufgelöst | ✓ |
| `.obsidian/`-Ordner (IDX-07) | Muss ignoriert werden | ✓ |
| Unresolved Wiki-Links + Namens-Kollisionen (LINK-02 / LINK-07) | LinkGraph-Robustheit | ✓ |

**User's choice:** Alle vier (Multi-Select).

---

## Claude's Discretion

Bewusst nicht diskutiert, an Research/Planner delegiert:

- Benchmark-Harness (Rust criterion? Frontend WebDriver/Tauri-driven?)
- CI-Provider + Runner-Strategie + macOS-Signing
- 24h-Soak-Methodologie
- Security-Audit-Werkzeugkette
- Crash-Recovery-Validation-Automatisierung
- Perf-Regression-Gating-Schwellen

## Deferred Ideas

Keine neuen Ideen während der Diskussion — alle Entscheidungen blieben im Scope.

---

*Log geschrieben: 2026-04-13*
