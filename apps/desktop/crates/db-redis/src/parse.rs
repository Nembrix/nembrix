//! Split editor text into Redis commands, `redis-cli` style.
//!
//! One command per line. Arguments are separated by whitespace; an argument
//! can be double-quoted (with `\n`, `\r`, `\t`, `\"`, `\\` and `\xHH` escapes)
//! or single-quoted (literal, only `\'` is an escape) — the same rules
//! `redis-cli` uses, so a command copied from a terminal runs unchanged.
//! Blank lines and lines starting with `#` or `//` are skipped.

/// One parsed command: the name plus its arguments, as raw bytes (a `\xHH`
/// escape can produce a non-UTF-8 argument).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub args: Vec<Vec<u8>>,
}

impl Command {
    /// The command name, upper-cased (`hgetall` → `HGETALL`).
    pub fn name(&self) -> String {
        String::from_utf8_lossy(&self.args[0]).to_ascii_uppercase()
    }

    /// The argument at `i` (0 = first argument after the name), upper-cased —
    /// for matching keywords like `WITHSCORES` or a `CONFIG GET` subcommand.
    pub fn arg_upper(&self, i: usize) -> Option<String> {
        self.args
            .get(i + 1)
            .map(|a| String::from_utf8_lossy(a).to_ascii_uppercase())
    }

    /// True when any argument after the name equals `kw` (case-insensitive).
    pub fn has_keyword(&self, kw: &str) -> bool {
        self.args[1..]
            .iter()
            .any(|a| a.eq_ignore_ascii_case(kw.as_bytes()))
    }

    /// The command as typed, for the multi-command result table.
    pub fn display(&self) -> String {
        self.args
            .iter()
            .map(|a| {
                let s = String::from_utf8_lossy(a);
                if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c == '"') {
                    format!("{s:?}")
                } else {
                    s.into_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Parse a whole editor buffer. Errors name the 1-based line.
pub fn parse_script(src: &str) -> Result<Vec<Command>, String> {
    let mut out = Vec::new();
    for (i, line) in src.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }
        let args = split_args(trimmed).map_err(|e| format!("line {}: {e}", i + 1))?;
        if !args.is_empty() {
            out.push(Command { args });
        }
    }
    if out.is_empty() {
        return Err("no command to run".into());
    }
    Ok(out)
}

/// Tokenize one line.
fn split_args(line: &str) -> Result<Vec<Vec<u8>>, String> {
    let mut args = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else {
            return Ok(args);
        };
        let mut cur: Vec<u8> = Vec::new();
        match first {
            '"' => {
                chars.next();
                loop {
                    match chars.next() {
                        None => return Err("unterminated double quote".into()),
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some('n') => cur.push(b'\n'),
                            Some('r') => cur.push(b'\r'),
                            Some('t') => cur.push(b'\t'),
                            Some('b') => cur.push(0x08),
                            Some('a') => cur.push(0x07),
                            Some('x') => {
                                let hex: String = (0..2).filter_map(|_| chars.next()).collect();
                                let byte = u8::from_str_radix(&hex, 16)
                                    .map_err(|_| format!("invalid \\x escape \"\\x{hex}\""))?;
                                cur.push(byte);
                            }
                            Some(c) => push_char(&mut cur, c),
                            None => return Err("unterminated double quote".into()),
                        },
                        Some(c) => push_char(&mut cur, c),
                    }
                }
                closing_quote_must_end_arg(&mut chars)?;
            }
            '\'' => {
                chars.next();
                loop {
                    match chars.next() {
                        None => return Err("unterminated single quote".into()),
                        Some('\'') => break,
                        Some('\\') if chars.peek() == Some(&'\'') => {
                            chars.next();
                            cur.push(b'\'');
                        }
                        Some(c) => push_char(&mut cur, c),
                    }
                }
                closing_quote_must_end_arg(&mut chars)?;
            }
            _ => {
                while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
                    push_char(&mut cur, c);
                }
            }
        }
        args.push(cur);
    }
}

/// `redis-cli` rejects `"a"b` — a closing quote must be followed by
/// whitespace or the end of the line.
fn closing_quote_must_end_arg(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
) -> Result<(), String> {
    match chars.peek() {
        Some(c) if !c.is_whitespace() => Err("closing quote must be followed by a space".into()),
        _ => Ok(()),
    }
}

fn push_char(buf: &mut Vec<u8>, c: char) {
    let mut tmp = [0u8; 4];
    buf.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        parse_script(line).unwrap()[0]
            .args
            .iter()
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect()
    }

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(args("  SET  user:1   alice "), ["SET", "user:1", "alice"]);
    }

    #[test]
    fn double_quotes_keep_spaces_and_unescape() {
        assert_eq!(
            args(r#"SET greeting "hello world\n\"quoted\"""#),
            ["SET", "greeting", "hello world\n\"quoted\""]
        );
    }

    #[test]
    fn hex_escapes_produce_raw_bytes() {
        let cmds = parse_script(r#"SET bin "\x00\xff""#).unwrap();
        assert_eq!(cmds[0].args[2], vec![0x00, 0xff]);
    }

    #[test]
    fn single_quotes_are_literal() {
        assert_eq!(args(r"SET k 'a\nb \'c\''"), ["SET", "k", r"a\nb 'c'"]);
    }

    #[test]
    fn empty_quoted_argument_is_kept() {
        assert_eq!(args(r#"SET k """#), ["SET", "k", ""]);
    }

    #[test]
    fn one_command_per_line_skipping_blanks_and_comments() {
        let cmds = parse_script("# seed\nSET a 1\n\n// next\nGET a\n").unwrap();
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[1].name(), "GET");
    }

    #[test]
    fn errors_name_the_line() {
        assert_eq!(
            parse_script("GET a\nSET b \"oops").unwrap_err(),
            "line 2: unterminated double quote"
        );
        assert!(parse_script(r#"SET "a"b c"#).is_err());
        assert!(parse_script("  \n# only a comment").is_err());
    }

    #[test]
    fn keyword_helpers_are_case_insensitive() {
        let c = &parse_script("zrange board 0 -1 withscores").unwrap()[0];
        assert_eq!(c.name(), "ZRANGE");
        assert!(c.has_keyword("WITHSCORES"));
        assert_eq!(c.arg_upper(0).as_deref(), Some("BOARD"));
    }

    #[test]
    fn display_quotes_args_that_need_it() {
        let c = &parse_script(r#"SET "my key" v"#).unwrap()[0];
        assert_eq!(c.display(), r#"SET "my key" v"#);
    }
}
