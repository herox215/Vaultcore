// Per-file anchor extraction (#62).
//
// Walks Markdown content with `pulldown-cmark` and emits two anchor tables:
//
//   - block anchors: `^blockid` tags trailing a paragraph, list item,
//     heading, or callout. The `id` is lowercased; `byte_end` excludes the
//     trailing tag so renderers can slice the block content cleanly.
//   - heading anchors: every heading, with a GFM-style slug derived from
//     the heading text (after stripping a trailing `^id`). `byte_end` is
//     the end of the heading section — the byte offset of the next heading
//     at the same or higher level, or the document end.
//
// Single source of truth for both Rust-side resolution (`resolve_anchor`)
// and the wire payload consumed by the frontend (`AnchorEntry::js_start /
// js_end` for direct slicing of UTF-16 JS strings).
//
// Anchor extraction is suppressed inside fenced/indented code blocks and
// inside `{{ ... }}` template-expression bodies — both would otherwise
// produce phantom anchors from source code that resembles a tag.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

use super::link_graph::{overlaps_any, template_expr_ranges};

// ── Public types ───────────────────────────────────────────────────────────────

/// Logical block kind that owns the trailing `^blockid` tag. Headings and
/// callouts are first-class so the embed-slice path can shape the rendered
/// content per the design brief without a second pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Paragraph,
    ListItem,
    Heading,
    Callout,
}

/// One block anchor (`^blockid`) extracted from a Markdown file.
#[derive(Debug, Clone)]
pub struct BlockAnchor {
    /// Lowercased id without the leading caret.
    pub id: String,
    /// 0-based line of the block's first line.
    pub line: u32,
    /// Byte offset (in the original UTF-8 content) of the block's first byte.
    pub byte_start: usize,
    /// Byte offset just past the last content byte of the block, **excluding**
    /// the trailing whitespace + `^id` tag. This is what slicers consume.
    pub byte_end: usize,
    pub kind: BlockKind,
}

/// One heading anchor — emitted for every heading in the document.
#[derive(Debug, Clone)]
pub struct HeadingAnchor {
    /// GFM-style slug, lowercased; collisions get `-1`, `-2`, ... in document
    /// order so each slug is unique within the file.
    pub slug: String,
    /// Original heading text (with `^id` trimmed if present).
    pub text: String,
    pub level: u8,
    pub line: u32,
    /// Byte offset of the heading's first byte.
    pub byte_start: usize,
    /// Byte offset of the **section** end: next heading at the same or higher
    /// level, or the document length. Heading-embed renderers slice
    /// `[byte_start..byte_end)` to show the heading + its body (per Vitruvius).
    pub byte_end: usize,
}

/// All anchors inside one file.
#[derive(Debug, Clone, Default)]
pub struct AnchorTable {
    pub blocks: Vec<BlockAnchor>,
    pub headings: Vec<HeadingAnchor>,
}

// ── Wire format (frontend payload) ─────────────────────────────────────────────
//
// `AnchorEntry` is what `get_resolved_anchors` returns. Two pairs of offsets:
//
//   - `byte_start` / `byte_end` — UTF-8 byte offsets, kept for tools and
//     tests that operate on raw bytes.
//   - `js_start` / `js_end`     — UTF-16 code-unit offsets. JS strings are
//     UTF-16 indexed; precomputing the conversion here lets the frontend
//     slice `noteContentCache` content directly with `String.prototype.slice`
//     without ever decoding bytes (Socrates B2). Multi-byte content (CJK,
//     emoji) would otherwise produce wrong slices.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorEntry {
    /// `id` for blocks, `slug` for headings.
    pub id: String,
    pub byte_start: u32,
    pub byte_end: u32,
    pub js_start: u32,
    pub js_end: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorKeySet {
    pub blocks: Vec<AnchorEntry>,
    pub headings: Vec<AnchorEntry>,
}

// ── Block-id regex ─────────────────────────────────────────────────────────────

fn block_id_trailer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Anchored to the line end so mid-paragraph `^foo` doesn't false-match.
        // `\s` includes CR so CRLF endings are absorbed before `\s*$`.
        Regex::new(r"(?m)\s\^([A-Za-z0-9-]+)\s*$").expect("invalid block-id regex")
    })
}

// ── Public API ─────────────────────────────────────────────────────────────────

/// Extract all anchors from `content`. Single pass over the markdown tree.
pub fn extract_anchors(content: &str) -> AnchorTable {
    let template_ranges = template_expr_ranges(content);
    let mut state = ExtractState::new(content, template_ranges);
    let parser = Parser::new_ext(content, Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES);
    for (event, range) in parser.into_offset_iter() {
        state.feed(event, range);
    }
    state.finish()
}

// ── Extraction state machine ───────────────────────────────────────────────────

struct ExtractState<'a> {
    content: &'a str,
    template_ranges: Vec<(usize, usize)>,
    blocks: Vec<BlockAnchor>,
    headings: Vec<HeadingAnchor>,
    /// Tracks whether we are currently inside a fenced/indented code block.
    /// `pulldown-cmark` events for `Tag::CodeBlock` bracket the contents.
    in_code_block: bool,
    /// Stack of open block-quote starts (byte offsets). The outermost open
    /// block quote whose first paragraph begins with `[!type]` is treated as
    /// a callout and tagged when its End fires.
    block_quote_stack: Vec<usize>,
    /// Open list-item ranges so a `^id` on the last line of a nested list
    /// item binds to its full `[byte_start..byte_end)`.
    list_item_stack: Vec<usize>,
    /// Open paragraph range — captured so a `^id` on a paragraph's last
    /// line gets the paragraph byte range, not the inline text range.
    paragraph_start: Option<usize>,
    /// Open heading state — `(byte_start, level, line)`.
    heading_stack: Vec<(usize, HeadingLevel, u32)>,
    /// Carry slugs already emitted to apply collision suffixes (-1, -2, ...).
    slug_counts: std::collections::HashMap<String, u32>,
}

impl<'a> ExtractState<'a> {
    fn new(content: &'a str, template_ranges: Vec<(usize, usize)>) -> Self {
        Self {
            content,
            template_ranges,
            blocks: Vec::new(),
            headings: Vec::new(),
            in_code_block: false,
            block_quote_stack: Vec::new(),
            list_item_stack: Vec::new(),
            paragraph_start: None,
            heading_stack: Vec::new(),
            slug_counts: std::collections::HashMap::new(),
        }
    }

    fn feed(&mut self, event: Event<'_>, range: std::ops::Range<usize>) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                self.in_code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                self.in_code_block = false;
            }
            Event::Start(Tag::BlockQuote(_)) => {
                self.block_quote_stack.push(range.start);
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                let start = self.block_quote_stack.pop().unwrap_or(range.start);
                if self.in_code_block {
                    return;
                }
                if !self.is_callout_quote(start, range.end) {
                    return;
                }
                self.try_emit_block_anchor(start, range.end, BlockKind::Callout);
            }
            Event::Start(Tag::Item) => {
                self.list_item_stack.push(range.start);
            }
            Event::End(TagEnd::Item) => {
                let start = self.list_item_stack.pop().unwrap_or(range.start);
                if self.in_code_block {
                    return;
                }
                self.try_emit_block_anchor(start, range.end, BlockKind::ListItem);
            }
            Event::Start(Tag::Paragraph) => {
                self.paragraph_start = Some(range.start);
            }
            Event::End(TagEnd::Paragraph) => {
                let start = self.paragraph_start.take().unwrap_or(range.start);
                if self.in_code_block {
                    return;
                }
                // A paragraph that lives directly inside a list item or
                // block quote has its own block-id binding deferred to the
                // outer container's End event. Skip emission here so the
                // tag binds to the list-item or callout, not the inner
                // paragraph fragment.
                if !self.list_item_stack.is_empty() || !self.block_quote_stack.is_empty() {
                    return;
                }
                self.try_emit_block_anchor(start, range.end, BlockKind::Paragraph);
            }
            Event::Start(Tag::Heading { level, .. }) => {
                let line = self.line_of(range.start);
                self.heading_stack.push((range.start, level, line));
            }
            Event::End(TagEnd::Heading(_)) => {
                let (start, level, line) = match self.heading_stack.pop() {
                    Some(v) => v,
                    None => return,
                };
                if self.in_code_block {
                    return;
                }
                // A heading may carry both a `^id` (block anchor) and a
                // slug (heading anchor). Emit both so `[[note^id]]` and
                // `[[note#Heading]]` resolve independently per the AC.
                let heading_slice = &self.content[start..range.end];
                let (text_no_id, block_id) = split_trailing_block_id(heading_slice);
                if let Some(id) = block_id {
                    let tag_len = trailing_block_id_byte_len(heading_slice);
                    let id_start = range.end - tag_len;
                    if !overlaps_any(&self.template_ranges, id_start, range.end) {
                        self.blocks.push(BlockAnchor {
                            id: id.to_lowercase(),
                            line,
                            byte_start: start,
                            byte_end: id_start,
                            kind: BlockKind::Heading,
                        });
                    }
                }
                let heading_text = strip_heading_markers(text_no_id);
                let raw_slug = slugify(&heading_text);
                let slug = self.disambiguate_slug(raw_slug);
                self.headings.push(HeadingAnchor {
                    slug,
                    text: heading_text,
                    level: heading_level_to_u8(level),
                    line,
                    byte_start: start,
                    // byte_end is patched in `finish()` once the next-sibling
                    // heading position is known.
                    byte_end: range.end,
                });
            }
            _ => {}
        }
    }

    fn try_emit_block_anchor(&mut self, start: usize, end: usize, kind: BlockKind) {
        let slice = &self.content[start..end];
        let (text_no_id, block_id) = split_trailing_block_id(slice);
        let _ = text_no_id;
        let id = match block_id {
            Some(s) => s,
            None => return,
        };
        let id_byte_len = trailing_block_id_byte_len(slice);
        let trimmed_end = end.saturating_sub(id_byte_len);
        // Template-overlap is checked against the tag's own byte range, not
        // the whole block — a paragraph may legitimately reference a template
        // body in its middle while still carrying a real `^id` tag at its
        // end. Only the tag location decides whether emission is suppressed.
        if overlaps_any(&self.template_ranges, trimmed_end, end) {
            return;
        }
        let line = self.line_of(start);
        // First-wins on duplicate ids within one file. Mirrors the
        // alias-collision pattern in link_graph.rs.
        if self.blocks.iter().any(|b| b.id == id.to_lowercase()) {
            log::info!(
                "duplicate block-id '{}' encountered; keeping first occurrence",
                id
            );
            return;
        }
        self.blocks.push(BlockAnchor {
            id: id.to_lowercase(),
            line,
            byte_start: start,
            byte_end: trimmed_end,
            kind,
        });
    }

    fn is_callout_quote(&self, start: usize, end: usize) -> bool {
        // Callouts open the blockquote with `> [!type]` on the first line.
        // Detection mirrors the frontend `parseCallout`: a blockquote whose
        // stripped first non-empty line begins with `[!`.
        let slice = &self.content[start..end];
        for raw_line in slice.lines() {
            let line = raw_line.trim_start();
            let after_quote = match line.strip_prefix('>') {
                Some(rest) => rest.trim_start(),
                None => continue,
            };
            if after_quote.is_empty() {
                continue;
            }
            return after_quote.starts_with("[!");
        }
        false
    }

    fn line_of(&self, byte: usize) -> u32 {
        if byte == 0 {
            return 0;
        }
        let count = self.content[..byte].bytes().filter(|&b| b == b'\n').count();
        count as u32
    }

    fn disambiguate_slug(&mut self, raw: String) -> String {
        let count = self.slug_counts.entry(raw.clone()).or_insert(0);
        let result = if *count == 0 {
            raw.clone()
        } else {
            format!("{}-{}", raw, count)
        };
        *count += 1;
        result
    }

    fn finish(mut self) -> AnchorTable {
        // Patch heading byte_end to the next-sibling heading start (same or
        // higher level) so heading-embed slicing covers heading + section
        // body up to (not including) the next heading at the same or higher
        // level. Last heading covers to EOF.
        let total = self.headings.len();
        let doc_end = self.content.len();
        for i in 0..total {
            let level_i = self.headings[i].level;
            let mut end = doc_end;
            for j in (i + 1)..total {
                if self.headings[j].level <= level_i {
                    end = self.headings[j].byte_start;
                    break;
                }
            }
            self.headings[i].byte_end = end;
        }
        AnchorTable {
            blocks: self.blocks,
            headings: self.headings,
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Split a block's text slice into `(text_without_trailing_id, Some(id))` if
/// it ends with `<whitespace>^<id><optional whitespace>`; `(slice, None)`
/// otherwise.
fn split_trailing_block_id(slice: &str) -> (&str, Option<String>) {
    let re = block_id_trailer_re();
    if let Some(cap) = re.captures(slice) {
        let m = cap.get(0).expect("capture 0 always present");
        let id = cap.get(1).expect("capture 1 always present").as_str().to_string();
        return (&slice[..m.start()], Some(id));
    }
    (slice, None)
}

/// Number of bytes consumed by the trailing `<ws>^id<ws>` tag, or 0 when no
/// tag is present. Used to compute `byte_end` exclusive of the tag.
fn trailing_block_id_byte_len(slice: &str) -> usize {
    let re = block_id_trailer_re();
    re.captures(slice)
        .and_then(|c| c.get(0))
        .map(|m| slice.len() - m.start())
        .unwrap_or(0)
}

/// Strip leading `#` markers + surrounding whitespace from a raw heading slice.
fn strip_heading_markers(slice: &str) -> String {
    let trimmed = slice.trim();
    let stripped = trimmed.trim_start_matches('#').trim();
    stripped.to_string()
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

/// GFM-style slugify with Obsidian-parity Unicode handling:
///   - lowercase (Unicode-aware via `str::to_lowercase`)
///   - whitespace runs → single `-`
///   - keep alphanumerics (Unicode), `-`, `_`; drop everything else
///   - collapse repeated `-`, trim ends
pub fn slugify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_dash = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_was_dash && !out.is_empty() {
                out.push('-');
                last_was_dash = true;
            }
            continue;
        }
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            for low in ch.to_lowercase() {
                out.push(low);
            }
            last_was_dash = false;
            continue;
        }
        // punctuation / emoji / other: drop, but treat consecutive drops as
        // potential dash boundaries only if separated by a space, which is
        // already handled by the whitespace branch above.
    }
    while out.ends_with('-') {
        out.pop();
    }
    while out.starts_with('-') {
        out.remove(0);
    }
    out
}

// ── Wire-format conversion ─────────────────────────────────────────────────────

/// Build the camelCase wire payload for one file. UTF-16 offsets are
/// computed by walking the content once and maintaining a running counter.
pub fn build_anchor_key_set(content: &str, table: &AnchorTable) -> AnchorKeySet {
    if table.blocks.is_empty() && table.headings.is_empty() {
        return AnchorKeySet::default();
    }
    let mut offsets: Vec<(usize, u32)> = Vec::new();
    // Collect every byte offset we need to translate, dedup, sort, then walk.
    for b in &table.blocks {
        offsets.push((b.byte_start, 0));
        offsets.push((b.byte_end, 0));
    }
    for h in &table.headings {
        offsets.push((h.byte_start, 0));
        offsets.push((h.byte_end, 0));
    }
    offsets.sort_by_key(|(b, _)| *b);
    offsets.dedup_by_key(|(b, _)| *b);

    let mut byte_to_js: std::collections::HashMap<usize, u32> =
        std::collections::HashMap::with_capacity(offsets.len());
    let mut js: u32 = 0;
    let mut byte_idx: usize = 0;
    let mut cursor = 0usize;
    let bytes = content.as_bytes();
    while byte_idx < offsets.len() {
        let target = offsets[byte_idx].0;
        if target == cursor {
            byte_to_js.insert(target, js);
            byte_idx += 1;
            continue;
        }
        if target < cursor || target > bytes.len() {
            // Out-of-range or already past — pin to current js position.
            byte_to_js.insert(target, js);
            byte_idx += 1;
            continue;
        }
        // Walk one Unicode scalar from `cursor`.
        let ch_len = utf8_char_len(bytes[cursor]);
        if cursor + ch_len > bytes.len() {
            byte_to_js.insert(target, js);
            byte_idx += 1;
            continue;
        }
        // SAFETY: we walked Unicode boundaries via `utf8_char_len`.
        let ch = std::str::from_utf8(&bytes[cursor..cursor + ch_len])
            .ok()
            .and_then(|s| s.chars().next());
        match ch {
            Some(c) => {
                js += c.len_utf16() as u32;
                cursor += ch_len;
            }
            None => {
                cursor += 1;
            }
        }
    }

    let mk = |id: &str, bs: usize, be: usize| -> AnchorEntry {
        AnchorEntry {
            id: id.to_string(),
            byte_start: bs as u32,
            byte_end: be as u32,
            js_start: byte_to_js.get(&bs).copied().unwrap_or(js),
            js_end: byte_to_js.get(&be).copied().unwrap_or(js),
        }
    };

    AnchorKeySet {
        blocks: table.blocks.iter().map(|b| mk(&b.id, b.byte_start, b.byte_end)).collect(),
        headings: table.headings.iter().map(|h| mk(&h.slug, h.byte_start, h.byte_end)).collect(),
    }
}

fn utf8_char_len(first_byte: u8) -> usize {
    match first_byte {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(table: &AnchorTable) -> Vec<&str> {
        table.blocks.iter().map(|b| b.id.as_str()).collect()
    }

    fn slugs(table: &AnchorTable) -> Vec<&str> {
        table.headings.iter().map(|h| h.slug.as_str()).collect()
    }

    #[test]
    fn paragraph_block_id_extracted() {
        let md = "Some paragraph text. ^para1\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["para1"]);
        assert_eq!(table.blocks[0].kind, BlockKind::Paragraph);
        // byte_end excludes the trailing tag
        let slice = &md[table.blocks[0].byte_start..table.blocks[0].byte_end];
        assert_eq!(slice.trim_end(), "Some paragraph text.");
    }

    #[test]
    fn list_item_block_id_extracted_with_children() {
        let md = "- top item ^itemA\n  - nested\n  - nested two\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["itema"]);
        let b = &table.blocks[0];
        let slice = &md[b.byte_start..b.byte_end];
        // Slice covers the top-level list item content, sans trailing tag.
        // (Nested items render as their own list-item containers in
        // pulldown-cmark's offset map; the embed-side renderer relies on
        // adjacent list-item ranges, not on the parent containing the
        // children byte-wise.)
        assert!(slice.contains("top item"));
        assert!(!slice.contains("^itemA"));
    }


    #[test]
    fn heading_emits_both_block_and_heading_anchor_when_tagged() {
        let md = "## Section ^sec1\n\nbody\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["sec1"]);
        assert_eq!(slugs(&table), vec!["section"]);
        assert_eq!(table.blocks[0].kind, BlockKind::Heading);
    }

    #[test]
    fn callout_block_id_covers_whole_quote() {
        let md = "> [!note]\n> body line one\n> body line two ^callout1\n\nafter\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["callout1"]);
        assert_eq!(table.blocks[0].kind, BlockKind::Callout);
        let slice = &md[table.blocks[0].byte_start..table.blocks[0].byte_end];
        assert!(slice.contains("[!note]"));
        assert!(slice.contains("body line one"));
        assert!(!slice.contains("^callout1"));
    }

    #[test]
    fn block_id_inside_code_fence_is_ignored() {
        let md = "```\nparagraph ^fake\n```\nreal paragraph ^real\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["real"]);
    }

    #[test]
    fn block_id_inside_template_body_is_ignored() {
        let md = "{{ vault.notes.where(n => n.name == \"x ^fake\") }}\nreal text ^real\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["real"]);
    }

    #[test]
    fn duplicate_block_ids_first_wins() {
        let md = "first ^dup\n\nsecond ^dup\n";
        let table = extract_anchors(md);
        assert_eq!(table.blocks.len(), 1);
        assert_eq!(table.blocks[0].id, "dup");
        // Ensure it's the first paragraph by checking line.
        assert_eq!(table.blocks[0].line, 0);
    }

    #[test]
    fn slug_collision_suffixes_in_document_order() {
        let md = "# Section\n\n# Section\n\n# Section\n";
        let table = extract_anchors(md);
        assert_eq!(slugs(&table), vec!["section", "section-1", "section-2"]);
    }

    #[test]
    fn unicode_slug_preserves_non_ascii_letters() {
        let md = "# Düsseldorf trip\n";
        let table = extract_anchors(md);
        assert_eq!(slugs(&table), vec!["düsseldorf-trip"]);
    }

    #[test]
    fn block_id_mid_text_is_not_extracted() {
        let md = "math: 2^3 = 8 and that's all\n";
        let table = extract_anchors(md);
        assert!(table.blocks.is_empty(), "got {:?}", table.blocks);
    }

    #[test]
    fn block_id_requires_leading_whitespace() {
        // `^foo` at line start (no leading whitespace) is not a tag.
        let md = "^notatag\n\ntext ^valid\n";
        let table = extract_anchors(md);
        assert_eq!(ids(&table), vec!["valid"]);
    }

    #[test]
    fn block_id_with_crlf_line_endings() {
        let md = "paragraph one ^id1\r\n\r\nparagraph two ^id2\r\n";
        let table = extract_anchors(md);
        let extracted: Vec<&str> = table.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(extracted, vec!["id1", "id2"]);
    }

    #[test]
    fn wikilink_with_block_anchor_in_paragraph_is_not_a_tag() {
        // `[[Note^id]]` text in a paragraph must not be mistaken for a
        // block-id tag — the tag is anchored to line end and `[[Note^id]]`
        // never sits at line end without `]]`.
        let md = "Reference: [[Note^id]] and that's the link.\n";
        let table = extract_anchors(md);
        assert!(table.blocks.is_empty());
    }

    #[test]
    fn heading_section_byte_end_stops_at_next_same_or_higher() {
        let md = "# A\n\nbody A\n\n## A1\n\nsub\n\n# B\n\nbody B\n";
        let table = extract_anchors(md);
        assert_eq!(slugs(&table), vec!["a", "a1", "b"]);
        let h_a = &table.headings[0];
        let slice = &md[h_a.byte_start..h_a.byte_end];
        // # A's section runs through # A1's body but stops before # B.
        assert!(slice.contains("body A"));
        assert!(slice.contains("## A1"));
        assert!(!slice.contains("# B"));
        let h_a1 = &table.headings[1];
        let slice = &md[h_a1.byte_start..h_a1.byte_end];
        // ## A1 stops at # B (higher-level heading).
        assert!(slice.contains("sub"));
        assert!(!slice.contains("# B"));
    }

    #[test]
    fn build_anchor_key_set_translates_byte_to_utf16() {
        // `é` is 2 bytes in UTF-8, 1 UTF-16 code unit. Emoji `🎉` is 4 bytes,
        // 2 UTF-16 code units (surrogate pair). The wire payload's
        // js_start/js_end must reflect these positions so JS string slicing
        // works correctly.
        let md = "café 🎉 paragraph ^p1\n";
        let table = extract_anchors(md);
        assert_eq!(table.blocks.len(), 1);
        let key_set = build_anchor_key_set(md, &table);
        assert_eq!(key_set.blocks.len(), 1);
        let entry = &key_set.blocks[0];
        // byte_start == 0 (paragraph starts at beginning); js_start == 0.
        assert_eq!(entry.byte_start, 0);
        assert_eq!(entry.js_start, 0);
        // byte_end excludes the trailing tag. Its corresponding JS index
        // must be the same character count to that point: c-a-f-é-space-🎉
        // -space-p-a-r-a-g-r-a-p-h-space.
        let prefix_text = &md[..entry.byte_end as usize];
        let expected_utf16: u32 = prefix_text.chars().map(|c| c.len_utf16() as u32).sum();
        assert_eq!(entry.js_end, expected_utf16);
    }

    #[test]
    fn slugify_strips_punctuation_keeps_unicode() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("**Bold** heading"), "bold-heading");
        assert_eq!(slugify("Düsseldorf 2026 — 一月"), "düsseldorf-2026-一月");
        assert_eq!(slugify("multi   space"), "multi-space");
        assert_eq!(slugify("---trim---"), "trim");
    }

    #[test]
    fn empty_content_returns_empty_table() {
        let table = extract_anchors("");
        assert!(table.blocks.is_empty());
        assert!(table.headings.is_empty());
    }
}
