//! What the command line takes, and its words for what it doesn't. `usage.json` holds every command, option and
//! argument as `src/cli.ts` declares them; the checks run in commander's order and speak its lines.
use clap::Command;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Spec {
    name: String,
    about: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    hidden: bool,
    /// It runs by itself, with or without subcommands.
    #[serde(default)]
    action: bool,
    #[serde(default)]
    after: String,
    #[serde(default)]
    options: Vec<Opt>,
    #[serde(default)]
    args: Vec<Arg>,
    #[serde(default)]
    commands: Vec<Spec>,
}

/// Flags, whether it must be given, what it is.
#[derive(Deserialize)]
struct Opt(String, bool, String);

/// Name, whether it must be given, whether it takes the rest, what it is.
#[derive(Deserialize)]
struct Arg(String, bool, bool, String);

impl Opt {
    fn takes_value(&self) -> bool {
        self.0.contains('<')
    }

    fn words(&self) -> impl Iterator<Item = &str> {
        self.0.split([',', ' ']).filter(|w| w.starts_with('-'))
    }

    fn long(&self) -> &str {
        self.words().find(|w| w.starts_with("--")).unwrap_or("")
    }

    fn is(&self, flag: &str) -> bool {
        self.words().any(|w| w == flag)
    }
}

impl Spec {
    pub fn load() -> Option<Spec> {
        serde_json::from_str(include_str!("usage.json")).ok()
    }

    fn command(&self, name: &str) -> Option<&Spec> {
        self.commands.iter().find(|c| c.name == name || c.aliases.iter().any(|a| a == name))
    }

    fn option(&self, flag: &str) -> Option<&Opt> {
        self.options.iter().find(|o| o.is(flag))
    }
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Nothing wrong with it, or help was asked for.
    Run,
    Version,
    Refuse(String),
}

fn maybe_option(arg: &str) -> bool {
    arg.len() > 1 && arg.starts_with('-')
}

fn negative_number(arg: &str) -> bool {
    regex::Regex::new(r"^-(\d+|\d*\.\d+)(e[+-]?\d+)?$").is_ok_and(|re| re.is_match(arg))
}

/// `parseOptions`: what isn't this command's own option is an operand until an option it doesn't know.
fn split(cmd: &Spec, args: &[String], seen: &mut Vec<String>) -> Result<(Vec<String>, Vec<String>), String> {
    let (mut operands, mut unknown): (Vec<String>, Vec<String>) = (vec![], vec![]);
    let mut strange = false;
    let mut group: Option<String> = None;
    let mut i = 0;
    while i < args.len() || group.is_some() {
        let arg = group.take().unwrap_or_else(|| {
            i += 1;
            args[i - 1].clone()
        });
        if arg == "--" {
            if strange {
                unknown.push(arg);
            }
            if strange { &mut unknown } else { &mut operands }.extend_from_slice(&args[i..]);
            break;
        }
        if let Some(option) = cmd.option(&arg).filter(|_| maybe_option(&arg)) {
            if option.takes_value() {
                i += 1;
                if i > args.len() {
                    return Err(format!("error: option '{}' argument missing", option.0));
                }
            }
            seen.push(option.long().to_string());
            continue;
        }
        let mut letters = arg.chars();
        if let (Some('-'), Some(letter), rest) = (letters.next(), letters.next().filter(|c| *c != '-'), letters.as_str()) {
            if let Some(option) = cmd.option(&format!("-{letter}")).filter(|_| !rest.is_empty()) {
                seen.push(option.long().to_string());
                if !option.takes_value() {
                    group = Some(format!("-{rest}"));
                }
                continue;
            }
        }
        if let Some(option) = arg.split_once('=').filter(|(flag, _)| flag.starts_with("--")).and_then(|(flag, _)| cmd.option(flag)).filter(|o| o.takes_value()) {
            seen.push(option.long().to_string());
            continue;
        }
        strange |= maybe_option(&arg) && !(cmd.commands.is_empty() && negative_number(&arg));
        if strange { &mut unknown } else { &mut operands }.push(arg);
    }
    Ok((operands, unknown))
}

/// `suggestSimilar`.
fn did_you_mean(word: &str, candidates: &[&str]) -> String {
    let dashes = if word.starts_with("--") { "--" } else { "" };
    let word: Vec<char> = word[dashes.len()..].chars().collect();
    let mut similar: Vec<&str> = vec![];
    let mut best = 3;
    for candidate in candidates.iter().map(|c| c.strip_prefix(dashes).unwrap_or(c)) {
        let letters: Vec<char> = candidate.chars().collect();
        let longest = word.len().max(letters.len());
        if letters.len() <= 1 || similar.contains(&candidate) {
            continue;
        }
        let distance = edits(&word, &letters);
        if distance > best || (longest - distance) as f64 / longest as f64 <= 0.4 {
            continue;
        }
        if distance < best {
            (best, similar) = (distance, vec![]);
        }
        similar.push(candidate);
    }
    similar.sort_unstable();
    let similar: Vec<String> = similar.iter().map(|s| format!("{dashes}{s}")).collect();
    match similar.as_slice() {
        [] => String::new(),
        [one] => format!("\n(Did you mean {one}?)"),
        many => format!("\n(Did you mean one of {}?)", many.join(", ")),
    }
}

/// Edit distance with swapped neighbours as one edit; far apart counts as nothing in common.
fn edits(a: &[char], b: &[char]) -> usize {
    if a.len().abs_diff(b.len()) > 3 {
        return a.len().max(b.len());
    }
    let mut d = vec![vec![0; b.len() + 1]; a.len() + 1];
    for i in 0..=a.len() {
        for j in 0..=b.len() {
            if i == 0 || j == 0 {
                d[i][j] = i + j;
                continue;
            }
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

fn unknown_option(chain: &[&Spec], flag: &str) -> Verdict {
    let mut known: Vec<&str> = vec![];
    for cmd in chain.iter().rev() {
        known.extend(cmd.options.iter().map(Opt::long));
        known.push("--help");
    }
    let hint = if flag.starts_with("--") { did_you_mean(flag, &known) } else { String::new() };
    Verdict::Refuse(format!("error: unknown option '{flag}'{hint}"))
}

fn unknown_command(cmd: &Spec, name: &str) -> Verdict {
    let mut known: Vec<&str> = vec![];
    for c in cmd.commands.iter().filter(|c| !c.hidden) {
        known.push(&c.name);
        known.extend(c.aliases.first().map(String::as_str));
    }
    known.push("help");
    Verdict::Refuse(format!("error: unknown command '{name}'{}", did_you_mean(name, &known)))
}

/// `_parseCommand`, up to running it. `own` names commands only this build has.
fn walk(chain: &[&Spec], mut operands: Vec<String>, rest: &[String], seen: &mut Vec<String>, own: &dyn Fn(&str) -> bool) -> Verdict {
    let Some(cmd) = chain.last() else { return Verdict::Run };
    let (more, unknown) = match split(cmd, rest, seen) {
        Ok(parts) => parts,
        Err(message) => return Verdict::Refuse(message),
    };
    operands.extend(more);
    if seen.iter().any(|s| s == "--version") {
        return Verdict::Version;
    }
    if let Some(first) = operands.first().filter(|f| !f.is_empty()) {
        if let Some(sub) = cmd.command(first) {
            let chain: Vec<&Spec> = chain.iter().copied().chain([sub]).collect();
            return walk(&chain, operands[1..].to_vec(), &unknown, seen, own);
        }
        if (!cmd.commands.is_empty() && first == "help") || (chain.len() == 1 && own(first)) {
            return Verdict::Run;
        }
    }
    if unknown.iter().any(|a| a == "-h" || a == "--help") || (!cmd.action && operands.is_empty() && unknown.is_empty()) {
        return Verdict::Run;
    }
    if let Some(missing) = cmd.options.iter().find(|o| o.1 && !seen.iter().any(|s| s == o.long())) {
        return Verdict::Refuse(format!("error: required option '{}' not specified", missing.0));
    }
    if !cmd.action {
        if let Some(name) = operands.first() {
            return unknown_command(cmd, name);
        }
    }
    if let Some(flag) = unknown.first() {
        return unknown_option(chain, flag);
    }
    if let Some(arg) = cmd.args.iter().enumerate().find(|(i, a)| a.1 && operands.len() <= *i).map(|(_, a)| a) {
        return Verdict::Refuse(format!("error: missing required argument '{}'", arg.0));
    }
    let expected = cmd.args.len();
    if operands.len() > expected && !cmd.args.last().is_some_and(|a| a.2) {
        let whose = if chain.len() > 1 { format!(" for '{}'", cmd.name) } else { String::new() };
        let s = if expected == 1 { "" } else { "s" };
        return Verdict::Refuse(format!("error: too many arguments{whose}. Expected {expected} argument{s} but got {}: {}.", operands.len(), operands.join(", ")));
    }
    Verdict::Run
}

pub fn check(spec: &Spec, args: &[String], own: &dyn Fn(&str) -> bool) -> Verdict {
    walk(&[spec], vec![], args, &mut vec![], own)
}

/// Gives a command its descriptions and examples, lets the last of a repeated option win and values start with a
/// dash, and hides what isn't declared.
pub fn dress(mut cmd: Command, spec: Option<&Spec>) -> Command {
    cmd = cmd.mut_args(|mut arg| {
        let positional = arg.is_positional();
        let flag = arg.get_long().map(|l| format!("--{l}")).unwrap_or_default();
        let about = spec.and_then(|s| if positional { s.args.first().map(|a| a.3.as_str()) } else { s.option(&flag).map(|o| o.2.as_str()) });
        if let Some(about) = about.filter(|a| !a.is_empty()) {
            arg = arg.help(about.to_string());
        }
        if positional {
            return arg.allow_negative_numbers(true);
        }
        let (id, value) = (arg.get_id().clone(), arg.get_action().takes_values());
        arg.overrides_with(id).allow_hyphen_values(value)
    });
    match spec {
        Some(s) => {
            cmd = cmd.about(s.about.clone()).hide(s.hidden);
            if !s.after.is_empty() {
                cmd = cmd.after_help(s.after.clone());
            }
        }
        None => cmd = cmd.hide(true),
    }
    let names: Vec<String> = cmd.get_subcommands().map(|c| c.get_name().to_string()).collect();
    for name in names {
        let sub = spec.and_then(|s| s.command(&name));
        let place = spec.and_then(|s| s.commands.iter().position(|c| c.name == name)).unwrap_or(usize::MAX);
        cmd = cmd.mut_subcommand(name, |c| dress(c, sub).display_order(place));
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(line: &str) -> Verdict {
        let spec = Spec::load().unwrap();
        let args: Vec<String> = line.split_whitespace().map(String::from).collect();
        check(&spec, &args, &|name| name == "serve")
    }

    fn refused(line: &str) -> String {
        match said(line) {
            Verdict::Refuse(text) => text,
            other => panic!("{line}: {other:?}"),
        }
    }

    #[test]
    fn what_is_missing_is_named_before_what_is_strange() {
        assert_eq!(refused("search code"), "error: required option '-P, --project-id <id>' not specified");
        assert_eq!(refused("search code --nope"), "error: required option '-P, --project-id <id>' not specified");
        assert_eq!(refused("search code -P demo"), "error: missing required argument 'query'");
        assert_eq!(refused("search code -P"), "error: option '-P, --project-id <id>' argument missing");
        assert_eq!(refused("model preset add"), "error: required option '--provider <provider>' not specified");
        assert_eq!(refused("branch pin -P demo"), "error: missing required argument 'branches'");
    }

    #[test]
    fn strange_words_are_answered_with_the_nearest_known_ones() {
        assert_eq!(refused("index --project-idd demo"), "error: unknown option '--project-idd'\n(Did you mean --project-id?)");
        assert_eq!(refused("gc -z"), "error: unknown option '-z'");
        assert_eq!(refused("project lst"), "error: unknown command 'lst'\n(Did you mean one of list, ls?)");
        assert_eq!(refused("project zzzzzzzz"), "error: unknown command 'zzzzzzzz'");
        assert_eq!(refused("projects a b"), "error: too many arguments for 'projects'. Expected 0 arguments but got 2: a, b.");
        assert_eq!(refused("completion bash zsh"), "error: too many arguments for 'completion'. Expected 1 argument but got 2: bash, zsh.");
        assert_eq!(refused("nonsense"), "error: too many arguments. Expected 0 arguments but got 1: nonsense.");
    }

    #[test]
    fn a_value_may_start_with_a_dash_and_an_option_may_come_twice() {
        for line in ["search code -P demo -5", "search code -P -x q", "search code -P a -P b q", "search code -Pdemo q", "search code --project-id=demo q", "search -x --help", "ignore", "project", "help index", "serve anything", "search two words --project-id demo", "gc -P demo -- ", "branch unpin -aP demo"] {
            assert_eq!(said(line), Verdict::Run, "{line}");
        }
        assert_eq!(said("--version"), Verdict::Version);
        assert_eq!(said("index -V"), Verdict::Version);
    }

    #[test]
    fn every_option_a_command_takes_is_declared() {
        use clap::CommandFactory;
        fn compare(cmd: &Command, spec: &Spec, path: &str) {
            for arg in cmd.get_arguments().filter(|a| !a.is_positional()) {
                let long = format!("--{}", arg.get_long().unwrap_or(""));
                assert!(spec.option(&long).is_some(), "{path}: {long}");
                assert_eq!(arg.get_action().takes_values(), spec.option(&long).unwrap().takes_value(), "{path}: {long}");
            }
            for sub in cmd.get_subcommands() {
                if let Some(s) = spec.command(sub.get_name()) {
                    compare(sub, s, &format!("{path} {}", sub.get_name()));
                }
            }
        }
        compare(&crate::Cli::command(), &Spec::load().unwrap(), "scrybe");
    }

    #[test]
    fn help_names_the_program_and_hides_what_is_not_declared() {
        use clap::CommandFactory;
        let spec = Spec::load().unwrap();
        let mut cmd = dress(crate::Cli::command(), Some(&spec));
        let help = cmd.render_help().to_string();
        assert!(help.contains("Usage: scrybe") && help.contains("  daemon ") && help.contains("  model "), "{help}");
        for hidden in ["debug-", "serve", "lookup", "add-project", "embed ", "  mcp"] {
            assert!(!help.contains(hidden), "{hidden}: {help}");
        }
        let index = cmd.find_subcommand_mut("index").unwrap().render_help().to_string();
        assert!(index.contains("Examples:\n  scrybe index -P myrepo\n") && index.contains("Project ID (omit when using --all)"), "{index}");
        dress(crate::Cli::command(), Some(&spec)).debug_assert();
    }
}
