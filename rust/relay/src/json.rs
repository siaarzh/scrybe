//! Just enough JSON to route messages without changing them. Values stay as raw text, so numbers,
//! key order and string escapes reach the client exactly as the server wrote them.

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

fn skip_string(b: &[u8], mut i: usize) -> Option<usize> {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// The index just past the value starting at `i`.
fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    let i = skip_ws(b, i);
    match *b.get(i)? {
        b'"' => skip_string(b, i),
        b'{' | b'[' => {
            let mut stack = vec![b[i]];
            let mut j = i + 1;
            while !stack.is_empty() {
                match *b.get(j)? {
                    b'"' => {
                        j = skip_string(b, j)?;
                        continue;
                    }
                    c @ (b'{' | b'[') => stack.push(c),
                    b'}' if stack.pop() != Some(b'{') => return None,
                    b']' if stack.pop() != Some(b'[') => return None,
                    _ => {}
                }
                j += 1;
            }
            Some(j)
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                j += 1;
            }
            (j > i).then_some(j)
        }
    }
}

/// The top-level fields of an object, as (key without quotes, raw value). None if it isn't one.
pub fn fields(raw: &str) -> Option<Vec<(&str, &str)>> {
    let b = raw.as_bytes();
    let mut i = skip_ws(b, 0);
    if *b.get(i)? != b'{' {
        return None;
    }
    i = skip_ws(b, i + 1);
    let mut out = Vec::new();
    if *b.get(i)? == b'}' {
        return (skip_ws(b, i + 1) == b.len()).then_some(out);
    }
    loop {
        if *b.get(i)? != b'"' {
            return None;
        }
        let key_end = skip_string(b, i)?;
        let key = raw.get(i + 1..key_end - 1)?;
        i = skip_ws(b, key_end);
        if *b.get(i)? != b':' {
            return None;
        }
        let start = skip_ws(b, i + 1);
        let end = skip_value(b, start)?;
        out.push((key, raw.get(start..end)?));
        i = skip_ws(b, end);
        match *b.get(i)? {
            b',' => i = skip_ws(b, i + 1),
            b'}' => return (skip_ws(b, i + 1) == b.len()).then_some(out),
            _ => return None,
        }
    }
}

pub fn get<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    fields(raw)?.into_iter().find(|(k, _)| *k == key).map(|(_, v)| v)
}

/// A raw JSON string's content, for simple values such as a method name. Escapes are left as they are.
pub fn bare(raw: &str) -> Option<&str> {
    raw.strip_prefix('"')?.strip_suffix('"')
}

/// Re-indents raw JSON the way JavaScript's `JSON.stringify(value, null, 2)` does.
pub fn pretty(raw: &str) -> String {
    let b = raw.as_bytes();
    let mut out = String::with_capacity(raw.len() + raw.len() / 4);
    let mut depth = 0usize;
    let mut i = 0;
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };
    while i < b.len() {
        match b[i] {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b'"' => {
                let end = skip_string(b, i).unwrap_or(b.len()).min(b.len());
                out.push_str(raw.get(i..end).unwrap_or(""));
                i = end;
            }
            c @ (b'{' | b'[') => {
                out.push(c as char);
                let next = skip_ws(b, i + 1);
                if matches!(b.get(next), Some(b'}' | b']')) {
                    out.push(b[next] as char);
                    i = next + 1;
                } else {
                    depth += 1;
                    newline(&mut out, depth);
                    i += 1;
                }
            }
            c @ (b'}' | b']') => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(c as char);
                i += 1;
            }
            b',' => {
                out.push(',');
                newline(&mut out, depth);
                i += 1;
            }
            b':' => {
                out.push_str(": ");
                i += 1;
            }
            _ => {
                let start = i;
                while i < b.len() && !matches!(b[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r' | b':') {
                    i += 1;
                }
                out.push_str(raw.get(start..i).unwrap_or(""));
            }
        }
    }
    out
}

/// Text as a JSON string, quotes included.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 8 + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_ignore_lookalikes_inside_values_and_strings() {
        let raw = r#"{"params":{"id":5,"x":"}, \"id\":9"},"note":"a,b}","id":"7,}"}"#;
        assert_eq!(get(raw, "id"), Some(r#""7,}""#));
        assert_eq!(get(raw, "note"), Some(r#""a,b}""#));
        assert_eq!(get(raw, "missing"), None);
        assert_eq!(get(r#" { "id" : 12 , "m" : [ 1 , 2 ] } "#, "m"), Some("[ 1 , 2 ]"));
    }

    #[test]
    fn broken_json_is_refused() {
        for bad in ["", "[1]", "{", r#"{"a"}"#, r#"{"a":}"#, r#"{"a":1"#, r#"{"a":[1}"#, r#"{"a":1} x"#, r#"{"a":"x"#] {
            assert_eq!(fields(bad), None, "{bad}");
        }
        assert_eq!(fields("{}"), Some(vec![]));
    }

    #[test]
    fn pretty_matches_javascript() {
        // Expected text printed by node: JSON.stringify(JSON.parse(raw), null, 2)
        let raw = r#"{"a":1,"b":[],"c":{},"d":[{"e":"x, y: {z}","f":null},true,1.5e-7],"g":"é\n\"q\""}"#;
        let want = "{\n  \"a\": 1,\n  \"b\": [],\n  \"c\": {},\n  \"d\": [\n    {\n      \"e\": \"x, y: {z}\",\n      \"f\": null\n    },\n    true,\n    1.5e-7\n  ],\n  \"g\": \"é\\n\\\"q\\\"\"\n}";
        assert_eq!(pretty(raw), want);
        assert_eq!(pretty(&pretty(raw)), want);
        assert_eq!(pretty("[]"), "[]");
        assert_eq!(pretty("7"), "7");
    }

    #[test]
    fn quote_escapes_what_json_requires() {
        assert_eq!(quote("a\"b\\c\nd\u{1}é"), r#""a\"b\\c\nd\u0001é""#);
    }
}
