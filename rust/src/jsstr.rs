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

/// `parseInt(s, 10)`: the number `s` starts with, `None` for NaN.
pub fn parse_int(s: &str) -> Option<f64> {
    let s = s.trim_start_matches(is_js_space);
    let (sign, rest) = match s.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    Some(sign * digits.parse::<f64>().ok()?)
}

/// What a number becomes as a 32-bit unsigned argument of a native call.
pub fn to_uint32(n: f64) -> u32 {
    if n.is_finite() { n.trunc().rem_euclid(4_294_967_296.0) as u32 } else { 0 }
}

/// Where `array.slice(0, n)` ends.
pub fn slice_end(len: usize, n: f64) -> usize {
    let n = n.trunc();
    if n < 0.0 { (len as f64 + n).max(0.0) as usize } else { len.min(n as usize) }
}

/// `parseInt` of an environment variable, `None` when it is unset or NaN.
pub fn env_int(name: &str) -> Option<f64> {
    parse_int(&std::env::var(name).ok()?)
}

/// `parseInt` of an environment variable when that is above zero.
pub fn env_pos_int(name: &str) -> Option<f64> {
    env_int(name).filter(|n| *n > 0.0)
}

/// `JSON.parse`: a lone half of a surrogate pair, which Rust text can't hold, becomes U+FFFD.
pub fn parse_json(text: &str) -> serde_json::Result<serde_json::Value> {
    serde_json::from_str(text).or_else(|e| if text.contains("\\u") { serde_json::from_str(&whole_surrogates(text)) } else { Err(e) })
}

/// JSON text with every lone surrogate escape replaced.
fn whole_surrogates(text: &str) -> String {
    let unit = |at: &str| at.strip_prefix("\\u").and_then(|h| h.get(..4)).and_then(|h| u16::from_str_radix(h, 16).ok());
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('\\') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let taken = match unit(rest) {
            Some(0xD800..=0xDBFF) if matches!(unit(&rest[6..]), Some(0xDC00..=0xDFFF)) => 12,
            Some(0xD800..=0xDFFF) => {
                out.push('\u{FFFD}');
                rest = &rest[6..];
                continue;
            }
            // The backslash and what it escapes.
            _ => 1 + rest[1..].chars().next().map_or(0, char::len_utf8),
        };
        out.push_str(&rest[..taken]);
        rest = &rest[taken..];
    }
    out + rest
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

/// `String(n)` for a finite number.
pub fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    let a = n.abs();
    if (1e-6..1e21).contains(&a) {
        return if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") };
    }
    let e = format!("{n:e}");
    match e.split_once('e') {
        Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}"),
        _ => e,
    }
}

/// `array.join(",")`: null becomes empty, an object `[object Object]`, a nested array is joined in turn.
pub fn js_join(items: &[serde_json::Value]) -> String {
    use serde_json::Value;
    let one = |v: &Value| -> String {
        match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js_number),
            Value::Array(a) => js_join(a),
            Value::Object(_) => "[object Object]".into(),
        }
    };
    items.iter().map(one).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_follows_javascript() {
        let v: Vec<serde_json::Value> = serde_json::from_str(r#"["z", null, 1, 1.5, true, {"a": 1}, ["x", null, [2]], 1e21, 0.0000001, -0.0]"#).unwrap();
        assert_eq!(js_join(&v), "z,,1,1.5,true,[object Object],x,,2,1e+21,1e-7,0");
        assert_eq!(js_join(&[]), "");
    }

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
    fn integers_are_read_from_the_front() {
        assert_eq!([" 42", "80abc", "-1", "+7", "0x1F", "70000"].map(parse_int), [42.0, 80.0, -1.0, 7.0, 0.0, 70000.0].map(Some));
        assert_eq!(["", "abc", "-", " ", "é1"].map(parse_int), [None; 5]);
    }

    #[test]
    fn counts_are_cut_like_javascript_cuts_them() {
        assert_eq!([10.0, 1.9, 0.0, -1.0, 1e20, f64::NAN, f64::INFINITY].map(to_uint32), [10, 1, 0, u32::MAX, 1_661_992_960, 0, 0]);
        assert_eq!([2.9, 0.0, -0.5, -1.0, -9.0, 1e20, f64::NAN].map(|n| slice_end(5, n)), [2, 0, 0, 4, 0, 5, 0]);
    }

    #[test]
    fn a_lone_surrogate_is_replaced_and_nothing_else_is() {
        for (json, text) in [
            (r#""a\ud800b""#, "a\u{FFFD}b"),
            (r#""\uDC00\ud83d\ude00""#, "\u{FFFD}😀"),
            (r#""\ud83d\ud83d\ude00\ud83d""#, "\u{FFFD}😀\u{FFFD}"),
            (r#""\\ud800\ud800\n""#, "\\ud800\u{FFFD}\n"),
            (r#""\ud800\\udc00é""#, "\u{FFFD}\\udc00é"),
            (r#""\\ud800""#, "\\ud800"),
        ] {
            assert_eq!(parse_json(json).unwrap(), text, "{json}");
        }
        for bad in [r#""\ud8""#, r#""\ud800"#, r#""\ud800" x"#, r#""\"#, "{", r#""\u+123""#, r#""\ué""#] {
            assert!(parse_json(bad).is_err(), "{bad}");
        }
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
