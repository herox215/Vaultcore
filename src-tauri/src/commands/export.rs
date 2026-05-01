// HTML export (#61).
//
// Renders a single note to a self-contained, offline-viewable HTML file:
//   * `![[image.png]]` embeds are inlined as `data:` URLs so the output file
//     can be moved anywhere (no external asset folder needed).
//   * `[[Wiki-link]]` references become intra-document anchor fragments for
//     resolvable headings inside the same note; everything else degrades to
//     plain text so the reader still sees the linked title.
//   * Theme CSS and readable-body styles are inlined in a `<style>` tag.
//
// The `note_path` is vault-scope-guarded like every other read; the
// `output_path` is *not* — it's chosen by the user through the native save
// dialog on the frontend and may legitimately sit outside the vault.

use crate::error::VaultError;
use crate::VaultState;
use base64::Engine;
use pulldown_cmark::{html, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
const SKIP_DIRS: &[&str] = &[".obsidian", ".git", ".vaultcore", ".trash"];

// ── Path helpers ─────────────────────────────────────────────────────────────

fn get_vault_root(state: &VaultState) -> Result<PathBuf, VaultError> {
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
    guard
        .as_ref()
        .map(|h| h.expect_posix().to_path_buf())
        .ok_or_else(|| VaultError::VaultUnavailable { path: String::from("<no vault>") })
}

fn ensure_inside_vault(vault: &Path, target: &Path) -> Result<PathBuf, VaultError> {
    let canonical = std::fs::canonicalize(target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: target.display().to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: target.display().to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    if !canonical.starts_with(vault) {
        return Err(VaultError::PermissionDenied {
            path: canonical.display().to_string(),
        });
    }
    Ok(canonical)
}

// ── Slug helper ──────────────────────────────────────────────────────────────

/// GitHub-flavoured slug: lowercase, spaces → `-`, strip chars that aren't
/// alphanumeric / dash / underscore. Collisions are resolved with a numeric
/// suffix by the caller.
fn slugify(s: &str) -> String {
    let lower = s.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c.is_whitespace() {
            out.push('-');
        }
    }
    out
}

// ── Attachment map ───────────────────────────────────────────────────────────

/// Walk the vault and return a `lowercased filename → absolute path` map for
/// every image attachment. Mirrors `get_resolved_attachments` but keeps
/// absolute paths so the exporter can read file bytes directly.
fn build_attachment_map(vault: &Path) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    for entry in walkdir::WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_str().unwrap_or("");
            if name.starts_with('.') {
                return false;
            }
            if e.file_type().is_dir() && SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d)) {
                return false;
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = match entry.path().extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_ascii_lowercase(),
            None => continue,
        };
        if !IMAGE_EXTENSIONS.iter().any(|e| *e == ext) {
            continue;
        }
        if let Some(fname) = entry.path().file_name().and_then(|n| n.to_str()) {
            map.entry(fname.to_ascii_lowercase())
                .or_insert_with(|| entry.path().to_path_buf());
        }
    }
    map
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

// ── Embed / wiki-link preprocessing ──────────────────────────────────────────

fn embed_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]").expect("embed re"))
}

fn wikilink_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]").expect("wikilink re"))
}

/// Replace `![[file.png]]` with a standard Markdown image whose `src` is a
/// base64 `data:` URL. Unresolvable filenames fall back to the alias / raw
/// target so the output still reads sensibly.
fn inline_image_embeds(md: &str, attachments: &HashMap<String, PathBuf>) -> String {
    let re = embed_regex();
    re.replace_all(md, |caps: &regex::Captures| -> String {
        let target = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        let alias = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        let key = target.to_ascii_lowercase();
        match attachments.get(&key) {
            Some(abs) => match std::fs::read(abs) {
                Ok(bytes) => {
                    let ext = abs
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_string();
                    let mime = mime_for_ext(&ext);
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let alt = if alias.is_empty() { target } else { alias };
                    format!("![{}](data:{};base64,{})", alt.replace(']', ""), mime, encoded)
                }
                Err(_) => {
                    if alias.is_empty() {
                        target.to_string()
                    } else {
                        alias.to_string()
                    }
                }
            },
            None => {
                if alias.is_empty() {
                    target.to_string()
                } else {
                    alias.to_string()
                }
            }
        }
    })
    .into_owned()
}

/// Convert `[[Heading]]` references into anchor-fragment links when the target
/// matches a heading in the same note; otherwise drop to plain text so the
/// reader still sees the linked phrase. Cross-note links are intentionally
/// collapsed to plain text — HTML export is single-file.
fn rewrite_wiki_links(md: &str, heading_slugs: &HashSet<String>) -> String {
    let re = wikilink_regex();
    re.replace_all(md, |caps: &regex::Captures| -> String {
        let target = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        let alias = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        let display = if alias.is_empty() { target } else { alias };

        // Heading anchor lookup: "Note#Heading" or bare "Heading".
        let heading_part = target.split_once('#').map(|(_, h)| h).unwrap_or(target);
        let slug = slugify(heading_part);
        if heading_slugs.contains(&slug) {
            format!("[{}](#{})", display, slug)
        } else {
            display.to_string()
        }
    })
    .into_owned()
}

/// First pass over the document: collect all heading slugs (with numeric
/// disambiguation) so wiki-link rewriting can target them. Returns a set of
/// slugs that actually exist in the rendered output.
fn collect_heading_slugs(md: &str) -> HashSet<String> {
    let parser = Parser::new_ext(md, Options::all());
    let mut slugs: HashSet<String> = HashSet::new();
    let mut current_text: Option<String> = None;
    for event in parser {
        match event {
            Event::Start(Tag::Heading { .. }) => {
                current_text = Some(String::new());
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(text) = current_text.take() {
                    let base = slugify(&text);
                    if base.is_empty() {
                        continue;
                    }
                    if !slugs.contains(&base) {
                        slugs.insert(base);
                    } else {
                        let mut n = 1u32;
                        loop {
                            let candidate = format!("{}-{}", base, n);
                            if !slugs.contains(&candidate) {
                                slugs.insert(candidate);
                                break;
                            }
                            n += 1;
                        }
                    }
                }
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some(buf) = current_text.as_mut() {
                    buf.push_str(&t);
                }
            }
            _ => {}
        }
    }
    slugs
}

// ── Markdown → HTML ──────────────────────────────────────────────────────────

/// Render Markdown to an HTML fragment. Headings are emitted with `id` attrs
/// so wiki-link anchors resolve inside the exported page.
fn render_markdown(md: &str) -> String {
    let parser = Parser::new_ext(md, Options::all());

    let mut assigned: HashSet<String> = HashSet::new();
    let mut current_text: Option<String> = None;
    let mut pending_level: Option<HeadingLevel> = None;
    let mut events: Vec<Event> = Vec::new();

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                pending_level = Some(level);
                current_text = Some(String::new());
                // Defer emission until End — we need the full heading text for the id.
            }
            Event::End(TagEnd::Heading(level)) => {
                let text = current_text.take().unwrap_or_default();
                let base = slugify(&text);
                let mut slug = base.clone();
                let mut n = 1u32;
                while !slug.is_empty() && assigned.contains(&slug) {
                    slug = format!("{}-{}", base, n);
                    n += 1;
                }
                if !slug.is_empty() {
                    assigned.insert(slug.clone());
                }

                let open_tag = format!(
                    "<h{level} id=\"{slug}\">",
                    level = heading_level_to_u8(level),
                    slug = html_escape(&slug)
                );
                let close_tag = format!("</h{level}>", level = heading_level_to_u8(level));

                events.push(Event::Html(open_tag.into()));
                events.push(Event::Text(text.into()));
                events.push(Event::Html(close_tag.into()));
                pending_level = None;
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some(buf) = current_text.as_mut() {
                    buf.push_str(&t);
                } else {
                    events.push(Event::Text(t));
                }
            }
            other => {
                if pending_level.is_some() {
                    // Inside a heading — ignore decorative events; the text buffer
                    // captures the user-visible content.
                } else {
                    events.push(other);
                }
            }
        }
    }

    let mut out = String::new();
    html::push_html(&mut out, events.into_iter());
    out
}

fn heading_level_to_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ── Document assembly ────────────────────────────────────────────────────────

const READABLE_CSS: &str = r#"
html, body { margin: 0; padding: 0; background: var(--color-bg, #F5F5F4); color: var(--color-text, #1C1C1A); }
body { font-family: var(--vc-font-body, system-ui, -apple-system, sans-serif); font-size: 16px; line-height: 1.65; }
main { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin-top: 1.6em; margin-bottom: 0.6em; }
h1 { font-size: 2em; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--color-border, #E5E5E4); padding-bottom: 0.2em; }
h3 { font-size: 1.25em; }
p { margin: 0.8em 0; }
a { color: var(--color-accent, #6D28D9); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; border-radius: 4px; }
code { font-family: var(--vc-font-mono, "JetBrains Mono", "Fira Code", monospace); background: var(--color-code-bg, #F3F4F6); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.92em; }
pre { background: var(--color-code-bg, #F3F4F6); padding: 1em; border-radius: 6px; overflow-x: auto; }
pre code { background: transparent; padding: 0; }
blockquote { border-left: 3px solid var(--color-border, #E5E5E4); margin: 1em 0; padding: 0.2em 1em; color: var(--color-text-muted, #6B7280); }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid var(--color-border, #E5E5E4); padding: 6px 10px; }
hr { border: none; border-top: 1px solid var(--color-border, #E5E5E4); margin: 2em 0; }
ul, ol { padding-left: 1.4em; }
@media print { body { background: #fff; color: #000; } a { color: #000; text-decoration: underline; } main { max-width: 100%; padding: 0; } }
"#;

fn wrap_document(title: &str, theme_css: &str, body_html: &str) -> String {
    let title_escaped = html_escape(title);
    let mut doc = String::with_capacity(body_html.len() + theme_css.len() + READABLE_CSS.len() + 512);
    doc.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    doc.push_str("<meta charset=\"utf-8\">\n");
    doc.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    doc.push_str("<title>");
    doc.push_str(&title_escaped);
    doc.push_str("</title>\n<style>\n");
    doc.push_str(theme_css);
    doc.push('\n');
    doc.push_str(READABLE_CSS);
    doc.push_str("\n</style>\n</head>\n<body>\n<main>\n");
    doc.push_str(body_html);
    doc.push_str("\n</main>\n</body>\n</html>\n");
    doc
}

// ── Public entry point (pure, testable) ──────────────────────────────────────

/// Render a Markdown string to a self-contained HTML document. `vault_root`
/// is used only to resolve `![[...]]` embeds — pass an empty map of
/// attachments to skip image inlining entirely.
pub fn build_export_html(
    title: &str,
    markdown: &str,
    theme_css: &str,
    attachments: &HashMap<String, PathBuf>,
) -> String {
    let with_images = inline_image_embeds(markdown, attachments);
    let slugs = collect_heading_slugs(&with_images);
    let rewritten = rewrite_wiki_links(&with_images, &slugs);
    let body_html = render_markdown(&rewritten);
    wrap_document(title, theme_css, &body_html)
}

// ── Tauri command ────────────────────────────────────────────────────────────

/// Render the note at `note_path` to a fully-inlined HTML document and return
/// it as a string. Shared between `export_note_html` (disk write) and the
/// frontend PDF-print flow (feeds the string into a hidden iframe).
///
/// `note_path` must be inside the open vault (same guard as `read_file`).
fn render_note(
    state: &VaultState,
    note_path: &str,
    theme_css: &str,
) -> Result<String, VaultError> {
    let vault_root = get_vault_root(state)?;
    let note_abs = ensure_inside_vault(&vault_root, &PathBuf::from(note_path))?;
    // #345: refuse to render ciphertext through the export / print
    // pipeline — pulldown-cmark over binary would either error or leak
    // garbage, and the "locked folder is fully invisible" contract
    // means export must refuse locked targets too.
    let canon = crate::encryption::CanonicalPath::assume_canonical(note_abs.clone());
    if state.locked_paths.is_locked(&canon) {
        return Err(VaultError::PathLocked {
            path: note_abs.display().to_string(),
        });
    }

    let bytes = std::fs::read(&note_abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: note_path.to_string() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: note_path.to_string() },
        _ => VaultError::Io(e),
    })?;
    let markdown = String::from_utf8(bytes)
        .map_err(|_| VaultError::InvalidEncoding { path: note_path.to_string() })?;

    let title = note_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Export")
        .to_string();

    let attachments = build_attachment_map(&vault_root);
    Ok(build_export_html(&title, &markdown, theme_css, &attachments))
}

/// Export the note at `note_path` to a self-contained HTML file at `output_path`.
///
/// `note_path` must be inside the open vault (same guard as `read_file`).
/// `output_path` is user-chosen (native save dialog) and written directly;
/// no vault-scope check — the dialog is the authority for where to write.
#[tauri::command]
pub async fn export_note_html(
    state: tauri::State<'_, VaultState>,
    note_path: String,
    output_path: String,
    theme_css: String,
) -> Result<(), VaultError> {
    let doc = render_note(&state, &note_path, &theme_css)?;

    std::fs::write(PathBuf::from(&output_path), doc).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: output_path.clone() },
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;
    Ok(())
}

/// Return the rendered HTML document for the note at `note_path` as a string.
///
/// Used by the PDF-print flow — the frontend drops the string into a hidden
/// iframe and invokes `window.print()`, which exposes the OS "Save as PDF"
/// option without needing a Tauri print plugin.
#[tauri::command]
pub async fn render_note_html(
    state: tauri::State<'_, VaultState>,
    note_path: String,
    theme_css: String,
) -> Result<String, VaultError> {
    render_note(&state, &note_path, &theme_css)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("  Mixed  Spaces  "), "mixed--spaces");
        assert_eq!(slugify("Heading #1"), "heading-1");
        assert_eq!(slugify("Über Größe"), "über-größe");
    }

    #[test]
    fn heading_slugs_collected() {
        let md = "# Intro\n\n## Details\n\n## Details\n";
        let slugs = collect_heading_slugs(md);
        assert!(slugs.contains("intro"));
        assert!(slugs.contains("details"));
        assert!(slugs.contains("details-1"));
    }

    #[test]
    fn wiki_links_to_anchor_when_heading_matches() {
        let md = "# Section A\n\nSee [[Section A]] for details.";
        let slugs = collect_heading_slugs(md);
        let out = rewrite_wiki_links(md, &slugs);
        assert!(out.contains("(#section-a)"));
    }

    #[test]
    fn wiki_links_degrade_when_unresolved() {
        let md = "Refer to [[Other Note]].";
        let slugs = HashSet::new();
        let out = rewrite_wiki_links(md, &slugs);
        assert!(!out.contains("[["));
        assert!(out.contains("Other Note"));
    }

    #[test]
    fn wiki_link_alias_used_for_display() {
        let md = "# Target\n\n[[Target|click here]]";
        let slugs = collect_heading_slugs(md);
        let out = rewrite_wiki_links(md, &slugs);
        assert!(out.contains("[click here](#target)"));
    }

    #[test]
    fn image_embed_missing_falls_back_to_alias() {
        let md = "![[nowhere.png|alt text]]";
        let attachments: HashMap<String, PathBuf> = HashMap::new();
        let out = inline_image_embeds(md, &attachments);
        assert_eq!(out.trim(), "alt text");
    }

    #[test]
    fn export_html_document_structure() {
        let md = "# Title\n\nSome **bold** text.";
        let doc = build_export_html("Test", md, ":root { --x: 1; }", &HashMap::new());
        assert!(doc.starts_with("<!DOCTYPE html>"));
        assert!(doc.contains("<title>Test</title>"));
        assert!(doc.contains(":root { --x: 1; }"));
        assert!(doc.contains("<h1 id=\"title\">Title</h1>"));
        assert!(doc.contains("<strong>bold</strong>"));
    }

    #[test]
    fn image_embed_inlines_as_data_url() {
        use std::fs;
        let tmp = tempfile::tempdir().unwrap();
        let img_path = tmp.path().join("pic.png");
        // Minimal PNG signature bytes (header only — enough to read as Vec<u8>).
        fs::write(&img_path, [137u8, 80, 78, 71, 13, 10, 26, 10]).unwrap();
        let mut map = HashMap::new();
        map.insert("pic.png".to_string(), img_path);
        let md = "![[pic.png]]";
        let out = inline_image_embeds(md, &map);
        assert!(out.contains("data:image/png;base64,"));
    }
}
