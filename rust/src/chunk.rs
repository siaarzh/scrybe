//! Cuts a file into chunks. Mirrors `src/plugins/code.ts` and `chunkLines` in `src/chunker.ts`
//! byte for byte, including their known defects, so ids stay valid.
use crate::jsstr::{js_len, js_slice, js_trim, split_lines};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;
use tree_sitter::{Language, Node, Parser};

/// The Node tree-sitter binding throws at this many UTF-16 units and the file falls back to
/// sliding windows. Kept deliberately: lifting it changes every big file's chunks.
const NODE_PARSE_LIMIT: usize = 32768;

#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub chunk_id: String,
    pub project_id: String,
    pub source_id: String,
    pub item_path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub language: String,
    pub symbol_name: String,
    pub content: String,
}

#[derive(Clone, Copy)]
pub struct Sizes {
    pub chunk_size: usize,
    pub overlap: usize,
}

impl Sizes {
    pub fn from_env() -> Self {
        let get = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        Sizes { chunk_size: get("SCRYBE_CHUNK_SIZE", 60), overlap: get("SCRYBE_CHUNK_OVERLAP", 10) }
    }
}

/// Hash of `project \0 source \0 path \0 url \0 type \0 content`.
pub fn chunk_id(project: &str, source: &str, path: &str, url: &str, kind: &str, content: &str) -> String {
    let mut h = Sha256::new();
    for (i, part) in [project, source, path, url, kind, content].iter().enumerate() {
        if i > 0 {
            h.update([0u8]);
        }
        h.update(part.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn grammar(lang: &str) -> Option<Language> {
    Some(match lang {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "csharp" => tree_sitter_c_sharp::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "ruby" => tree_sitter_ruby::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        _ => return None,
    })
}

fn declaration_types(lang: &str) -> &'static [&'static str] {
    match lang {
        "typescript" => &["function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"],
        "javascript" => &["function_declaration", "method_definition", "class_declaration"],
        "csharp" => &["class_declaration", "interface_declaration", "method_declaration", "constructor_declaration"],
        "python" => &["function_definition", "class_definition"],
        "go" => &["function_declaration", "method_declaration", "type_declaration"],
        "rust" => &["function_item", "impl_item", "struct_item", "enum_item", "trait_item"],
        "java" => &["class_declaration", "interface_declaration", "enum_declaration", "method_declaration", "constructor_declaration"],
        "ruby" => &["method", "singleton_method", "class", "module"],
        "c" => &["function_definition"],
        "cpp" => &["function_definition", "class_specifier", "struct_specifier"],
        _ => &[],
    }
}

const CLASS_LIKE: &[&str] = &["class_declaration", "interface_declaration", "class_definition", "impl_item", "class_specifier", "struct_specifier"];

fn node_name(node: Node, source: &str) -> String {
    let named = node.child_by_field_name("name");
    let found = named.or_else(|| {
        let mut cursor = node.walk();
        let hit = node.children(&mut cursor).find(|c| matches!(c.kind(), "identifier" | "type_identifier" | "property_identifier"));
        hit
    });
    found.map(|n| source[n.byte_range()].to_string()).unwrap_or_default()
}

struct Decl<'a> {
    symbol: String,
    start: usize,
    end: usize,
    content: &'a str,
}

fn walk<'a>(node: Node, types: &[&str], source: &'a str, offset: usize, parent: Option<&str>, out: &mut Vec<Decl<'a>>) {
    if types.contains(&node.kind()) {
        let name = node_name(node, source);
        let symbol = match parent {
            Some(p) if !p.is_empty() && !name.is_empty() => format!("{p}.{name}"),
            _ => name,
        };
        out.push(Decl { symbol: symbol.clone(), start: node.start_position().row + offset, end: node.end_position().row + offset, content: &source[node.byte_range()] });
        if CLASS_LIKE.contains(&node.kind()) {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                walk(child, types, source, offset, Some(&symbol), out);
            }
        }
        return;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk(child, types, source, offset, parent, out);
    }
}

pub struct Window {
    pub start: i64,
    pub end: i64,
    pub content: String,
}

/// `truncateToCharCap`: keep the leading lines that fit, hard-cut a single oversized line.
fn truncate_to_cap(lines: &[&str], max: usize) -> (String, usize) {
    let (mut count, mut used) = (0, 0);
    for line in lines {
        let n = js_len(line);
        if used > 0 && count + n > max {
            break;
        }
        count += n;
        used += 1;
    }
    let used = used.max(1);
    let mut content = lines[..used.min(lines.len())].concat();
    if js_len(&content) > max {
        content = js_slice(&content, max);
    }
    (js_trim(&content).to_string(), used)
}

/// `chunkLines`: sliding window over lines.
pub fn chunk_lines(lines: &[&str], offset: usize, max: Option<usize>, sizes: Sizes) -> Vec<Window> {
    let step = sizes.chunk_size - sizes.overlap;
    let mut out = vec![];
    let mut i = 0;
    while i < lines.len() {
        let slice = &lines[i..(i + sizes.chunk_size).min(lines.len())];
        let joined = slice.concat();
        let content = js_trim(&joined);
        if !content.is_empty() {
            match max.filter(|m| js_len(content) > *m) {
                Some(m) => {
                    let (capped, used) = truncate_to_cap(slice, m);
                    if !capped.is_empty() {
                        out.push(Window { start: (offset + i + 1) as i64, end: (offset + i + used) as i64, content: capped });
                    }
                }
                None => out.push(Window { start: (offset + i + 1) as i64, end: (offset + i + slice.len()) as i64, content: content.to_string() }),
            }
        }
        i += step;
    }
    out
}

thread_local! {
    static PARSERS: RefCell<HashMap<String, Parser>> = RefCell::new(HashMap::new());
}

struct Ctx<'a> {
    project: &'a str,
    source: &'a str,
    path: &'a str,
    max: Option<usize>,
    sizes: Sizes,
}

impl Ctx<'_> {
    fn stamp(&self, content: String, start: i64, end: i64, language: &str, symbol: &str) -> Chunk {
        Chunk {
            chunk_id: chunk_id(self.project, self.source, self.path, "", "code", &content),
            project_id: self.project.to_string(),
            source_id: self.source.to_string(),
            item_path: self.path.to_string(),
            start_line: start,
            end_line: end,
            language: language.to_string(),
            symbol_name: symbol.to_string(),
            content,
        }
    }

    fn ast(&self, text: &str, lang: &str, line_offset: usize) -> Vec<Chunk> {
        if js_len(text) >= NODE_PARSE_LIMIT {
            return vec![];
        }
        let Some(language) = grammar(lang) else { return vec![] };
        let tree = PARSERS.with(|p| {
            let mut parsers = p.borrow_mut();
            let parser = parsers.entry(lang.to_string()).or_insert_with(|| {
                let mut parser = Parser::new();
                parser.set_language(&language).expect("grammar ABI");
                parser
            });
            parser.parse(text, None)
        });
        let Some(tree) = tree else { return vec![] };
        let mut decls = vec![];
        walk(tree.root_node(), declaration_types(lang), text, line_offset, None, &mut decls);
        if decls.is_empty() {
            return vec![];
        }
        let lines = split_lines(text);
        let mut out = vec![];
        for d in decls {
            let content = js_trim(d.content);
            let fits = d.end - d.start + 1 <= self.sizes.chunk_size && self.max.is_none_or(|m| js_len(content) <= m);
            if fits {
                out.push(self.stamp(content.to_string(), d.start as i64 + 1, d.end as i64 + 1, lang, &d.symbol));
            } else {
                // Same quirk as the TypeScript: for Vue the line numbers include the offset, so this
                // slice can land on the wrong lines.
                let from = d.start.min(lines.len());
                let to = (d.end + 1).min(lines.len());
                let mut first = true;
                for w in chunk_lines(&lines[from..to], d.start, self.max, self.sizes) {
                    out.push(self.stamp(w.content, w.start, w.end, lang, if first { &d.symbol } else { "" }));
                    first = false;
                }
            }
        }
        out
    }

    fn sliding(&self, text: &str, language: &str) -> Vec<Chunk> {
        chunk_lines(&split_lines(text), 0, self.max, self.sizes).into_iter().map(|w| self.stamp(w.content, w.start, w.end, language, "")).collect()
    }
}

fn vue_script(source: &str) -> Option<(&str, usize)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?is)<script(?:\s[^>]*)?>(\n?)(.*?)</script[^>]*>").unwrap());
    let caps = re.captures(source)?;
    let whole = caps.get(0)?;
    let code = caps.get(2)?;
    // `match[0].indexOf(match[2])`: the first occurrence, which an empty script puts at 0.
    let inner = whole.as_str().find(code.as_str()).unwrap_or(0);
    let line_offset = source[..whole.start() + inner].matches('\n').count();
    Some((code.as_str(), line_offset))
}

/// `chunkFileContent`.
pub fn chunk_file(project: &str, source: &str, path: &str, text: &str, language: &str, max: Option<usize>, sizes: Sizes) -> Vec<Chunk> {
    let ctx = Ctx { project, source, path, max, sizes };
    if language == "vue" {
        if let Some((code, offset)) = vue_script(text) {
            let chunks = ctx.ast(code, "typescript", offset);
            if !chunks.is_empty() {
                return chunks;
            }
        }
        return ctx.sliding(text, language);
    }
    if grammar(language).is_some() {
        let chunks = ctx.ast(text, language, 0);
        if !chunks.is_empty() {
            return chunks;
        }
    }
    ctx.sliding(text, language)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZES: Sizes = Sizes { chunk_size: 60, overlap: 10 };

    #[test]
    fn id_matches_node_createhash() {
        // node -e "crypto.createHash('sha256').update('p\0s\0a.ts\0\0code\0x').digest('hex')"
        assert_eq!(chunk_id("p", "s", "a.ts", "", "code", "x"), "e4193d7ece0bc7cb1f30fb827b17e190180cfa3b34408f1506ed663538418b72");
    }

    #[test]
    fn python_declarations_get_dotted_symbols() {
        let chunks = chunk_file("p", "s", "a.py", "class A:\n    def f(self):\n        return 1\n", "python", Some(2048), SIZES);
        let syms: Vec<_> = chunks.iter().map(|c| c.symbol_name.as_str()).collect();
        assert_eq!(syms, ["A", "A.f"]);
        assert_eq!(chunks[1].start_line, 2);
    }

    #[test]
    fn files_at_the_node_limit_fall_back_to_windows() {
        let big = format!("def f():\n    return 1\n{}", "#".repeat(32768 - 22));
        let chunks = chunk_file("p", "s", "a.py", &big, "python", Some(2048), SIZES);
        assert!(chunks.iter().all(|c| c.symbol_name.is_empty()));
    }

    #[test]
    fn empty_file_makes_no_chunks() {
        assert!(chunk_file("p", "s", "a.py", "", "python", None, SIZES).is_empty());
    }
}
