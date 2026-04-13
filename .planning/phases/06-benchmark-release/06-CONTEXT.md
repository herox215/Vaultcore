# Phase 6: Benchmark & Release - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Reine Validierungs- und Release-Phase — keine neuen Features, kein User-facing UI. Beweise, dass VaultCore seinen Kernwert hält:

1. **Performance-Budgets** — Alle 13 PERF-Budgets aus Spec §7 gegen einen reproduzierbaren 100.000-Notes-Vault treffen (Cold Start < 3 s, Warm Start < 5 s, Note Open < 100 ms, Keystroke < 16 ms, Full-Text < 50 ms, Quick Switcher < 10 ms, Backlinks < 20 ms, Link-Autocomplete < 10 ms, Initial Indexing < 60 s, Incremental Update < 5 ms, RAM idle < 100 MB, RAM active < 250 MB, 24 h ohne Crash) + ERR-05 Crash-Recovery ≤ 2 s.
2. **Release** — Alpha-Builds für macOS (Intel + Apple Silicon), Windows 10/11, Linux (Ubuntu 22.04+, Fedora 38+), alle Unit-/Integration-/Frontend-Tests grün in CI (REL-01..04).
3. **Security** — Nachweis zero network calls, zero telemetry, vault data never leaves local filesystem (SEC-01..03).

**Requirements in scope:** PERF-01..13, REL-01..04, SEC-01..03, ERR-05 — 21 total.

**Out of scope:** Neue Features, Refactors von bereits gelieferten Phase-1–5-Modulen (außer zur Budget-Einhaltung nötig), Plugin-System, Graph View, Mobile, Attachments.

</domain>

<decisions>
## Implementation Decisions

### Test-Vault-Generator

- **D-01:** Generator als Rust-Binary im Repo. Ein `bin`-Target (z.B. `src-tauri/src/bin/gen_vault.rs` oder ein Workspace-bin) wird über `cargo run --bin gen-vault -- --out <path> --count 100000 --seed <n>` aufgerufen. Gründe: nutzt bestehende Crates, deterministisch via fixen Seed, in CI trivial aufrufbar, keine neuen Sprach-Dependencies. Research-Agent entscheidet, ob es ein neues `[[bin]]`-Target in `src-tauri/Cargo.toml` wird oder ein schmales Workspace-Crate — minimale Umstrukturierung bevorzugt.
- **D-02:** Content-Stil = **Markov-Chain** auf Basis einer fixen bilingualen Wortliste (ca. 5–10k deutsche + englische Tokens, im Repo eingecheckt als `tests/fixtures/wordlist.txt` oder vergleichbar). Seed-basiert reproduzierbar. Liefert plausibel verteilte Tokens für Tantivy-Ranking (kein künstlicher „alles matched alles"-Effekt wie bei Lorem ipsum).
- **D-03:** Link-/Tag-Dichte = **realistisch**. Pro Note 3–8 `[[random-note]]`-Verweise + 2–5 Tags (inline `#tag` oder YAML-Frontmatter, Mischung beider Quellen). Pareto-Verteilung: wenige „Hub-Notes" mit 100+ Backlinks, der Rest normal. Stellt sicher, dass PERF-07 (Backlinks < 20 ms) und PERF-08 (Link-Autocomplete < 10 ms) unter realistischen Graph-Topologien greifen.
- **D-04:** Dateigröße = **Gauss-Verteilung** um μ=500 Wörter, σ=200 Wörter, plus eine deterministische Sonder-Kohorte von ~10 Notes mit 10.000 Zeilen Text, um EDIT-08-Regression permanent mitzuprüfen.
- **D-05:** Ordner-Struktur = **hierarchisch mit Pareto-Verteilung**. Baum 3–5 Ebenen tief, die meisten Notes in mittleren Ebenen, einige Root-Notes. Enthält absichtlich mehrere Namens-Kollisionen (z.B. zwei `Index.md` in unterschiedlichen Ordnern), damit LINK-02 (3-Stufen-Shortest-Path) und der Tree-Lazy-Loader realistisch gestresst werden.
- **D-06:** Edge-Cases, die der Generator einstreuen muss:
  - Kleine Anzahl non-UTF-8-Dateien (Latin-1/Shift-JIS-Bytes) → IDX-08 + FILE-09 Regression
  - 5–10 symbolische Links auf andere Notes → FILE-08 Regression
  - `.obsidian/`-Ordner mit typischen Dateien (`app.json`, `workspace.json`) → IDX-07 Regression
  - Absichtliche Unresolved Wiki-Links (`[[does-not-exist]]`) + mehrere Notes mit gleichem Namen → LINK-02 + LINK-07 Regression
- **D-07:** Vault-Bereitstellung in CI: **On-demand-Generierung mit Cache-Key** `(generator_version_hash, seed, count, flags)`. Erste CI-Läufe regenerieren (~1–2 min), nachfolgende ziehen aus `actions/cache` (oder äquivalent). Kein Einchecken des generierten Vaults im Repo, keine Git-LFS-Abhängigkeit. Lokale Entwickler rufen dasselbe Binary auf.
- **D-08:** CLI-Flags des Generators sollen mindestens umfassen: `--out <path>`, `--count <n>` (default 100000), `--seed <n>` (default fest), sowie optionale Dichte-Überschreibungen (`--link-density`, `--tag-density`) für Ad-hoc-Stresstests. Defaults entsprechen D-03/D-04/D-05 — ein Aufruf ohne Flags muss den kanonischen Benchmark-Vault produzieren.

### Claude's Discretion

Die folgenden Bereiche wurden bewusst nicht festgelegt — Research- und Planner-Agents entscheiden auf Basis des Codes, der Spec und aktueller Tooling-Landschaft:

- **Benchmark-Harness:** Rust-Seite vermutlich `criterion`, Frontend-Seite (Keystroke, Note-Open, Cold Start) über Tauri-WebDriver / headless Tauri / manuelle Instrumentierung — Research soll vergleichen und empfehlen.
- **CI-Provider & Matrix:** vermutlich GitHub Actions (kein bestehender CI-Setup im Repo). Self-hosted vs. hosted Runner für den 100k-Vault-Gate, Nightly vs. PR-Cadence, macOS-Signing/Notarization.
- **Release-Distribution:** GitHub Releases als Default-Kanal, Signing-Strategie offen, ggf. unsigned für Alpha.
- **24h-Soak-Methodologie:** automatisiert vs. manuell, Metriken-Erfassung, auf welcher Plattform ausgeführt.
- **Security-Audit-Vorgehen:** `cargo audit` + Tauri-Capability-Review + runtime syscall capture (`strace`/`dtrace`/`pktmon`) — Methodikwahl offen.
- **Crash-Recovery-Validation (ERR-05):** automatisierter SIGKILL + Relaunch-Test vs. manuelles UAT.
- **Perf-Regression-Gating:** Schwellwerte (hart < Budget vs. 10 % Puffer), Trend-Tracking, wo Zahlen persistiert werden.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Specification
- `VaultCore_MVP_Spezifikation_v3.md` §7 — Performance-Benchmarks (alle PERF-Budget-Zielwerte mit Obsidian-Referenz)
- `VaultCore_MVP_Spezifikation_v3.md` §14 — Nicht-funktionale Anforderungen (Qualität, Sicherheit, UX)
- `VaultCore_MVP_Spezifikation_v3.md` §15 M6 — Benchmark-Milestone-Akzeptanzkriterien (100k-Vault, 24h-Dauerbetrieb, alle 3 Plattformen, Alpha-Build)
- `VaultCore_MVP_Spezifikation_v3.md` §16 — Risiken & Mitigationen (Tantivy RAM bei 100k+, In-Memory-Index RAM, Tauri Webview-Unterschiede)
- `VaultCore_MVP_Spezifikation_v3.md` §17 — Entscheidungslog (Crash Recovery 2 s, kein WAL; YAML only; `.trash/`-Delete; Obsidian-Import)

### Projekt-Kontext
- `.planning/PROJECT.md` — Core Value, Performance-Constraints, Plattform-Liste, Security-Non-Negotiables
- `.planning/REQUIREMENTS.md` — 21 REQ-IDs dieser Phase: PERF-01..13, REL-01..04, SEC-01..03, ERR-05
- `.planning/ROADMAP.md` §Phase 6 — Success Criteria dieser Phase

### Frühere Phasen-Contexts (Kontinuität)
- `.planning/phases/01-skeleton/01-CONTEXT.md` — Rust-Modul-Tree, Auto-Save-Extension (Crash-Recovery-Grundlage für ERR-05)
- `.planning/phases/02-vault/02-CONTEXT.md` — Watcher + Merge-Engine (Basis für SYNC-bezogene Benchmarks)
- `.planning/phases/03-search/03-CONTEXT.md` — Tantivy-Schema, zentrale Write-Queue, Index-Versioning (Basis für PERF-01/02/05/09)
- `.planning/phases/04-links/04-CONTEXT.md` — LinkGraph-Topologie (Basis für PERF-07/08)
- `.planning/phases/05-polish/05-CONTEXT.md` — TagIndex, Theme, Shortcuts, Hash-Verify-Merge (Basis für PERF-03/04/10)

### Source-Treffpunkte (Code, der Benchmarks ansteuern wird)
- `src-tauri/Cargo.toml` — hier erscheint neues `[[bin]]`-Target für Generator + ggf. `[dev-dependencies] criterion`
- `src-tauri/src/indexer/` — Indexing-Pfade für PERF-01/02/05/09/10
- `src-tauri/src/indexer/link_graph.rs` — Backlinks/Autocomplete-Pfade für PERF-07/08
- `src-tauri/src/indexer/tantivy_index.rs` — Full-Text-Pfade für PERF-05
- `src-tauri/src/indexer/tag_index.rs` — Tag-Scan-Pfade (RAM-Relevanz PERF-11/12)
- `src-tauri/src/watcher.rs` — Incremental-Update-Pfad für PERF-10
- `src-tauri/src/commands/` — alle IPC-Eintrittspunkte, die aus dem Frontend gemessen werden
- `src/components/Editor/autoSave.ts` — Crash-Recovery-Fenster (ERR-05)
- `src/components/Editor/CMEditor.svelte` — Keystroke-Latency (PERF-04)
- `src-tauri/tauri.conf.json` — `bundle.targets = all`, identifier; Basis für REL-01

### Neue Artefakte, die Phase 6 erzeugen wird
- Test-Vault-Generator-Binary + eingecheckte Wortliste
- Benchmark-Harness (Rust-Seite + Frontend-Seite — Technologie offen in Research)
- CI-Workflows in `.github/workflows/` (aktuell nicht existent)
- Alpha-Build-Artefakte für macOS/Windows/Linux
- Security-Audit-Bericht (Format offen)
- Performance-Ergebnisse/Trend-Dokument

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Bestehende Unit-Tests-Infrastruktur in `src-tauri/src/tests/` (error_serialize, files, files_ops, hash_verify, indexer, link_graph, merge, tag_index, tree, vault_stats, watcher) — Benchmark-Gate muss diese Tests weiter grün halten
- Frontend-Tests in `tests/` (autoSave, indexProgress, keymap, Toast, vault, WelcomeScreen) unter Vitest + jsdom — Basis für REL-04
- Deterministische Seeds bereits in mehreren Tests etabliert (pnpm-Lockfile, serde camelCase) — Pattern für Generator übernehmen
- `IndexCoordinator` zentrale Queue + `rayon` für Batch-Parsing — dieselben Pfade müssen gebenchmarkt werden (keine Neuimplementierung)
- `tauri.conf.json` hat bereits `bundle.targets = "all"` gesetzt → Cross-Platform-Bundling ist prinzipiell schon aktiviert

### Established Patterns
- `tempfile` als dev-dep für filesystem-lastige Tests → derselbe Crate eignet sich für Generator-Fixtures
- `serde rename_all camelCase` für IPC-Structs → Benchmark-Metriken folgen gleicher Konvention, falls persistiert
- localStorage-Keys mit `vaultcore-` Prefix → falls Benchmark-Runs lokal persistiert werden, Prefix beibehalten
- Signal-Store-Pattern (scrollStore/treeRefreshStore/tabReloadStore) → nicht phase-relevant, aber Benchmarks dürfen diese Pfade nicht umgehen
- Svelte 5 $derived-Fallen (aus user memory) — Frontend-Perf-Messungen müssen Reactivity-Graphen wie in Produktion durchlaufen, nicht umgehen

### Integration Points
- Noch kein `.github/` oder CI-Konfig vorhanden → Phase 6 legt die CI-Pipeline erstmals an
- Keine bestehenden Benchmarks / `benches/`-Verzeichnis → Greenfield für Perf-Harness
- `tauri-plugin-fs` + `tauri-plugin-dialog` sind einzige Tauri-Plugins mit Network-Risiko — Security-Audit muss Capability-Files unter `src-tauri/capabilities/` prüfen
- Kein existierendes Logging-/Metriken-Framework im Rust-Backend außer `log`+`env_logger` → Benchmark-Instrumentierung baut darauf auf oder führt `criterion` neu ein

</code_context>

<specifics>
## Specific Ideas

- „Stay fluid at 100k+ notes" ist der non-negotiable Leitsatz — wenn irgendein PERF-Budget im generierten Vault reißt, blockiert das das Alpha-Release. Keine weichen Pässe.
- Obsidian-Referenzzahlen aus Spec §7 sind die rhetorische Vergleichsbasis — Benchmark-Ergebnisse werden idealerweise im selben Tabellen-Format dokumentiert (VaultCore-Zahl | Budget | Obsidian-Referenz), damit die 10–100×-Story sichtbar bleibt.
- Generator-Output soll auch als regelmäßiger UAT-Sandbox nutzbar sein — ein Entwickler sollte lokal `cargo run --bin gen-vault -- --out /tmp/v100k` ausführen und denselben Vault wie CI erhalten können.

</specifics>

<deferred>
## Deferred Ideas

- **Plugin-System als Performance-Constraint** — v0.2 Thema, nicht in dieser Phase.
- **Graph View Performance** — v0.3 Thema.
- **Attachment-Indexing Perf** — post-MVP, Architektur ist vorbereitet.
- **Mobile-Benchmarks** — iOS/Android ist post-v0.1; Phase 6 nur Desktop.
- **Perf-Regressions-Dashboard mit historischem Trend** — reines „Gate"-Gating reicht für Alpha; Trend-Tracking kann v0.2 folgen.
- **Signierte Release-Binaries + Notarization** — falls Research zum Schluss kommt, dass Alpha unsigned akzeptabel ist, wandert Signing/Notarization zum Beta-Release.
- **Automatisierte 24h-Soak in CI** — hardware-teuer; falls Research zu dem Schluss kommt, dass manuelle 24h-Läufe auf einer Entwicklermaschine ausreichen, dann ist automated soak v0.2 deferred.

</deferred>

---

*Phase: 06-benchmark-release*
*Context gathered: 2026-04-13*
