//! `String.prototype.localeCompare` for sort order. Covers ASCII per the CLDR root collation
//! Node uses; anything else sorts by code point after ASCII (known gap).
use std::cmp::Ordering;

const PUNCT_ORDER: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

fn primary(c: char) -> u32 {
    if c.is_ascii_whitespace() {
        return 1;
    }
    if let Some(i) = PUNCT_ORDER.find(c) {
        return 10 + i as u32;
    }
    if c.is_ascii_digit() {
        return 100 + c as u32 - '0' as u32;
    }
    if c.is_ascii_alphabetic() {
        return 200 + c.to_ascii_lowercase() as u32 - 'a' as u32;
    }
    if c.is_ascii() {
        return 5;
    }
    1000 + c as u32
}

pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let by_primary = a.chars().map(primary).cmp(b.chars().map(primary));
    if by_primary != Ordering::Equal {
        return by_primary;
    }
    // Tertiary level: lowercase sorts before uppercase.
    for (x, y) in a.chars().zip(b.chars()) {
        if x != y {
            return match (x.is_ascii_lowercase(), y.is_ascii_lowercase()) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => x.cmp(&y),
            };
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::locale_compare as lc;
    use std::cmp::Ordering::*;

    #[test]
    fn matches_node_for_cases_seen_in_paths() {
        // Each expectation taken from node: 'a'.localeCompare('b') on v22.
        assert_eq!(lc("a", "B"), Less);
        assert_eq!(lc("B", "a"), Greater);
        assert_eq!(lc("a", "A"), Less);
        assert_eq!(lc("a_b", "a-b"), Less);
        assert_eq!(lc("a-b", "a.b"), Less);
        assert_eq!(lc("a/b", "a1"), Less);
        assert_eq!(lc("a1", "ab"), Less);
        assert_eq!(lc("abc", "abc"), Equal);
    }
}
