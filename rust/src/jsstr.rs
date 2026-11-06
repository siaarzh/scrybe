//! JavaScript string semantics the chunk ids depend on: lengths in UTF-16 units, `trim`, and
//! `split(/^/m)`. One byte different means a silent re-embed, so these are exact.

/// `s.length`
pub fn js_len(s: &str) -> usize {
    if s.is_ascii() { s.len() } else { s.encode_utf16().count() }
}

/// `s.slice(0, n)`. A split surrogate pair becomes U+FFFD, which is what Node hashes it as.
pub fn js_slice(s: &str, n: usize) -> String {
    if s.is_ascii() {
        return s[..n.min(s.len())].to_string();
    }
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// `s.trim()`. Rust's `trim` differs: it also strips U+0085, and keeps U+FEFF.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.split(/^/m)`: breaks after \n, \r, U+2028 and U+2029, with no empty tail.
pub fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return vec![""];
    }
    let mut out = vec![];
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            let end = i + c.len_utf8();
            out.push(&s[start..end]);
            start = end;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// `normalizeContent`: strip one leading BOM, collapse CRLF and lone CR to LF.
pub fn normalize_content(s: &str) -> String {
    let s = s.strip_prefix('\u{FEFF}').unwrap_or(s);
    if !s.contains('\r') {
        return s.to_string();
    }
    s.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_count_utf16_units() {
        assert_eq!(js_len("abc"), 3);
        assert_eq!(js_len("é"), 1);
        assert_eq!(js_len("😀"), 2);
    }

    #[test]
    fn slice_can_split_a_surrogate_pair() {
        assert_eq!(js_slice("a😀b", 2), "a\u{FFFD}");
        assert_eq!(js_slice("abc", 9), "abc");
    }

    #[test]
    fn trim_follows_js_not_rust() {
        assert_eq!(js_trim("\u{FEFF} a \u{A0}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn split_matches_js_multiline_caret() {
        assert_eq!(split_lines("a\nb"), ["a\n", "b"]);
        assert_eq!(split_lines("a\n"), ["a\n"]);
        assert_eq!(split_lines("\n\n"), ["\n", "\n"]);
        assert_eq!(split_lines(""), [""]);
        assert_eq!(split_lines("a\u{2028}b"), ["a\u{2028}", "b"]);
    }

    #[test]
    fn normalize_handles_bom_and_line_endings() {
        assert_eq!(normalize_content("\u{FEFF}a\r\nb\rc\n"), "a\nb\nc\n");
    }
}
