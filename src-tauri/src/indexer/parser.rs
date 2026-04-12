// Markdown-to-plain-text stripper for the Tantivy body field.
//
// T-03-01 mitigation: pulldown-cmark emits only plain text events — no raw
// HTML passes through. This prevents XSS when SnippetGenerator wraps matches
// in <b> tags (Pitfall 5 from RESEARCH.md).

use pulldown_cmark::{Event, Options, Parser};

/// Strip Markdown formatting and return plain text suitable for full-text indexing.
///
/// - Heading markers, bold/italic delimiters, link syntax are dropped.
/// - Code spans and code blocks contribute their text content (not the fences).
/// - Soft/hard line breaks become a single space so words don't merge.
/// - HTML tags are not passed through (T-03-01 mitigation).
pub fn strip_markdown(md: &str) -> String {
    let parser = Parser::new_ext(md, Options::empty());
    let mut plain = String::with_capacity(md.len());
    for event in parser {
        match event {
            Event::Text(t) | Event::Code(t) => plain.push_str(&t),
            Event::SoftBreak | Event::HardBreak => plain.push(' '),
            _ => {}
        }
    }
    plain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(strip_markdown(""), "");
    }

    #[test]
    fn heading_and_bold_stripped() {
        // "# Hello **world**" → "Hello world"
        let result = strip_markdown("# Hello **world**");
        assert_eq!(result, "Hello world");
    }

    #[test]
    fn code_fence_stripped_to_text() {
        // Code block content is kept, fences are dropped.
        let md = "```rust\nfn main() {}\n```";
        let result = strip_markdown(md);
        assert_eq!(result.trim(), "fn main() {}");
    }

    #[test]
    fn inline_code_kept() {
        let result = strip_markdown("Use `cargo build` to compile.");
        assert_eq!(result, "Use cargo build to compile.");
    }

    #[test]
    fn soft_break_becomes_space() {
        let result = strip_markdown("line one\nline two");
        assert!(result.contains(' '));
    }
}
