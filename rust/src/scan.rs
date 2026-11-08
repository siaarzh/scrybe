//! Which files get indexed. Mirrors `walkRepoFiles` and `getLanguage` in `src/chunker.ts`, and
//! `src/ignore-rules.ts`, including node-ignore's rule that an ignored parent can't be re-included.
use crate::config::data_dir;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::{Path, PathBuf};

const SKIP_DIRS: &[&str] = &[".git", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".nuxt", "coverage", ".pytest_cache", ".mypy_cache", ".ruff_cache", "target", "bin", "obj", "packages", ".vs", "TestResults", "publish", "artifacts", "~ExternalLibraries", "Dommel", "vendor", "android", "ios", "electron", "fastlane"];
const SKIP_EXTENSIONS: &[&str] = &[".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".tar", ".gz", ".map"];
const SKIP_FILENAMES: &[&str] = &["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "Gemfile.lock", "Pipfile.lock", "composer.lock", "poetry.lock", "go.sum"];

pub fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name) || name.starts_with("Intra.Old.")
}

/// Node's `path.extname`: a leading dot alone is not an extension.
fn extname(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn language_of(name: &str) -> Option<&'static str> {
    let base = name.rsplit('/').next().unwrap_or(name);
    if base.ends_with(".min.js") || base.ends_with(".min.css") {
        return None;
    }
    if base.ends_with(".g.cs") || base.ends_with(".designer.cs") || base.ends_with(".Designer.cs") || base.ends_with(".generated.cs") {
        return None;
    }
    let ext = extname(base);
    if SKIP_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    Some(match ext.as_str() {
        ".py" => "python",
        ".ts" => "typescript",
        ".tsx" => "tsx",
        ".js" | ".jsx" => "javascript",
        ".vue" => "vue",
        ".kt" => "kotlin",
        ".java" => "java",
        ".cs" => "csharp",
        ".go" => "go",
        ".rs" => "rust",
        ".rb" => "ruby",
        ".php" => "php",
        ".swift" => "swift",
        ".cpp" | ".hpp" => "cpp",
        ".c" | ".h" => "c",
        ".html" => "html",
        ".css" => "css",
        ".scss" => "scss",
        ".json" => "json",
        ".yaml" | ".yml" => "yaml",
        ".toml" => "toml",
        ".md" => "markdown",
        ".sh" => "bash",
        _ => return None,
    })
}

pub struct IgnoreRules {
    rules: Option<Gitignore>,
    force: Option<Gitignore>,
    force_patterns: Vec<String>,
}

fn builder(root: &Path) -> GitignoreBuilder {
    let mut b = GitignoreBuilder::new(root);
    // node-ignore defaults to case-insensitive.
    b.case_insensitive(true).expect("no case-insensitive error before add");
    b
}

fn add_all(b: &mut GitignoreBuilder, content: &str) {
    for line in content.lines() {
        let _ = b.add_line(None, line);
    }
}

impl IgnoreRules {
    pub fn load(root: &Path, project: Option<&str>, source: Option<&str>) -> Self {
        let mut b = builder(root);
        let mut has = false;
        let mut force_patterns = vec![];
        if let Ok(text) = std::fs::read_to_string(root.join(".gitignore")) {
            add_all(&mut b, &text);
            has = true;
        }
        let collect = |text: &str, force: &mut Vec<String>| {
            for line in text.lines() {
                let t = line.trim();
                if t.len() > 1 && t.starts_with('!') {
                    force.push(t[1..].to_string());
                }
            }
        };
        if let Ok(text) = std::fs::read_to_string(root.join(".scrybeignore")) {
            add_all(&mut b, &text);
            has = true;
            collect(&text, &mut force_patterns);
        }
        if let (Some(p), Some(s)) = (project, source) {
            if let Ok(text) = std::fs::read_to_string(data_dir().join("ignores").join(p).join(format!("{s}.gitignore"))) {
                if !text.is_empty() {
                    add_all(&mut b, &text);
                    has = true;
                    collect(&text, &mut force_patterns);
                }
            }
        }
        let force = (!force_patterns.is_empty()).then(|| {
            let mut fb = builder(root);
            add_all(&mut fb, &force_patterns.join("\n"));
            fb.build().unwrap_or_else(|_| Gitignore::empty())
        });
        let rules = has.then(|| b.build().unwrap_or_else(|_| Gitignore::empty()));
        IgnoreRules { rules, force, force_patterns }
    }

    /// node-ignore walks from the top: the first ignored parent decides.
    fn ignored_by(g: &Gitignore, rel: &str) -> bool {
        let mut end = 0;
        while let Some(i) = rel[end..].find('/') {
            end += i;
            if g.matched(&rel[..end], true).is_ignore() {
                return true;
            }
            end += 1;
        }
        g.matched(rel, false).is_ignore()
    }

    pub fn should_ignore(&self, rel: &str) -> bool {
        self.rules.as_ref().is_some_and(|g| Self::ignored_by(g, rel))
    }

    pub fn is_force_included(&self, rel: &str) -> bool {
        self.force.as_ref().is_some_and(|g| Self::ignored_by(g, rel))
    }

    fn dir_might_force(&self, rel: &str) -> bool {
        let prefix = format!("{rel}/");
        self.force_patterns.iter().any(|p| p == rel || *p == prefix || p.starts_with(&prefix))
    }
}

/// `walkRepoFiles`. Symlinks are neither files nor directories here, as with Node's dirent.
/// `scanRef` with a branch: every indexable blob of a git ref, as (path, normalized content), in git's order.
pub fn scan_ref(root: &Path, git_ref: &str, project: Option<&str>, source: Option<&str>) -> Vec<(String, String)> {
    let rules = IgnoreRules::load(root, project, source);
    let Some(listing) = crate::git::output(root, &["ls-tree", "--full-tree", "-r", "-z", git_ref], Some(50 << 20)) else { return vec![] };
    let max_bytes = std::env::var("SCRYBE_MAX_FILE_BYTES").ok().and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0).unwrap_or(1 << 20);
    let mut out = vec![];
    for entry in listing.split('\0').filter(|e| !e.is_empty()) {
        let Some((meta, rel)) = entry.split_once('\t') else { continue };
        // Symlinks and submodules have no content to index.
        if matches!(meta.split(' ').next(), Some("120000" | "160000")) {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if language_of(name).is_none() || rules.should_ignore(rel) {
            continue;
        }
        let Some(raw) = crate::git::output(root, &["show", &format!("{git_ref}:{rel}")], Some(max_bytes)) else { continue };
        let content = crate::jsstr::normalize_content(&raw);
        if content.len() > max_bytes {
            continue;
        }
        out.push((rel.to_string(), content));
    }
    out
}

pub fn walk_repo_files(root: &Path, project: Option<&str>, source: Option<&str>) -> Vec<(String, PathBuf)> {
    let rules = IgnoreRules::load(root, project, source);
    let mut out = vec![];
    walk_dir(root, root, &rules, &mut out);
    out
}

/// Depth first in directory order, like the TypeScript generator: file order decides batches.
fn walk_dir(root: &Path, dir: &Path, rules: &IgnoreRules, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    // libuv sorts names by bytes, and file order decides batches, which change vectors.
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let abs = entry.path();
        let rel = abs.strip_prefix(root).unwrap_or(&abs).to_string_lossy().replace('\\', "/");
        if kind.is_dir() {
            if skip_dir(&name) && !rules.dir_might_force(&rel) {
                continue;
            }
            walk_dir(root, &abs, rules, out);
        } else if kind.is_file() {
            let forced = rules.is_force_included(&rel);
            if !forced && SKIP_FILENAMES.contains(&name.as_str()) {
                continue;
            }
            if !forced && language_of(&name).is_none() {
                continue;
            }
            if rules.should_ignore(&rel) {
                continue;
            }
            out.push((rel, abs));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extname_matches_node() {
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("a.TS"), ".ts");
        assert_eq!(extname("a.b.js"), ".js");
    }

    #[test]
    fn generated_and_minified_files_have_no_language() {
        assert_eq!(language_of("x.min.js"), None);
        assert_eq!(language_of("x.g.cs"), None);
        assert_eq!(language_of("x.cs"), Some("csharp"));
        assert_eq!(language_of("x.tsx"), Some("tsx"));
    }

    #[test]
    fn an_ignored_parent_cannot_be_reincluded() {
        let root = Path::new("/r");
        let mut b = builder(root);
        add_all(&mut b, "dir/\n!dir/keep.txt\n*.LOG\n");
        let g = b.build().unwrap();
        assert!(IgnoreRules::ignored_by(&g, "dir/keep.txt"));
        assert!(IgnoreRules::ignored_by(&g, "a/x.log"));
        assert!(!IgnoreRules::ignored_by(&g, "a/x.txt"));
    }
}
