//! A small, hand-written parser for the slice of the mongo shell language
//! the editor actually sends. It is deliberately *not* a JS engine: we
//! recognise the `db.<collection>.<method>(...)` call shape plus a handful
//! of `db.<helper>(...)` admin calls, parse their arguments as
//! (extended) JSON / BSON, and map the result onto one [`Command`].
//!
//! What we support — chosen to match what nosqlbooster autocompletes and
//! what people type by hand 95% of the time:
//!
//! ```text
//! db.users.find({ age: { $gt: 21 } }).sort({ name: 1 }).limit(50).skip(10)
//! db.users.findOne({ _id: 1 })
//! db.orders.aggregate([{ $match: { paid: true } }, { $group: { ... } }])
//! db.users.countDocuments({ active: true })
//! db.users.estimatedDocumentCount()
//! db.users.distinct("country", { active: true })
//! db.users.insertOne({ name: "ada" })
//! db.users.insertMany([{ ... }, { ... }])
//! db.users.updateOne({ _id: 1 }, { $set: { x: 2 } })
//! db.users.updateMany({ active: false }, { $set: { archived: true } })
//! db.users.replaceOne({ _id: 1 }, { ... })
//! db.users.deleteOne({ _id: 1 })
//! db.users.deleteMany({ active: false })
//! db.runCommand({ ping: 1 })
//! db.getCollectionNames()
//! ```
//!
//! Cursor modifiers (`.sort/.limit/.skip/.projection`) are only meaningful
//! after `find`, and we attach them there. Anything we don't recognise
//! returns [`ParseError`] with a message the editor surfaces verbatim —
//! we never silently run a different query than the user typed.
//!
//! Argument values are parsed as *relaxed* shell-style JSON: unquoted
//! object keys are allowed (`{ age: 1 }`), single quotes are allowed, and
//! trailing commas are tolerated. Mongo operators (`$gt`, `$set`, …) are
//! just string keys, so no special handling is needed — they round-trip
//! through the JSON layer and BSON conversion happens downstream.

use mongodb::bson::{Bson, Document};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("expected `db.<collection>.<method>(…)` or a `db.<helper>(…)` call")]
    NotADbCall,
    #[error("unknown method `{0}` — supported: find, findOne, aggregate, count, distinct, insert*, update*, replaceOne, delete*")]
    UnknownMethod(String),
    #[error("unknown db helper `{0}`")]
    UnknownHelper(String),
    #[error("`{method}` expects {expected} argument(s), got {got}")]
    Arity { method: String, expected: &'static str, got: usize },
    #[error("argument {idx} to `{method}` must be {expected}")]
    BadArgType { method: String, idx: usize, expected: &'static str },
    #[error("could not parse argument JSON: {0}")]
    Json(String),
    #[error("unbalanced or malformed call: {0}")]
    Syntax(String),
}

pub type Result<T> = std::result::Result<T, ParseError>;

/// Modifiers attached to a `find` cursor before it's run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FindOpts {
    pub filter: Document,
    pub projection: Option<Document>,
    pub sort: Option<Document>,
    pub limit: Option<i64>,
    pub skip: Option<u64>,
}

/// One parsed shell statement. The driver matches on this; the parser never
/// touches the network.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Find { collection: String, opts: FindOpts },
    /// `findOne` is `find` with limit 1; we keep it distinct so the driver
    /// can shape the result as a single document if it wants to.
    FindOne { collection: String, filter: Document, projection: Option<Document> },
    Aggregate { collection: String, pipeline: Vec<Document> },
    CountDocuments { collection: String, filter: Document },
    EstimatedDocumentCount { collection: String },
    Distinct { collection: String, field: String, filter: Document },
    InsertOne { collection: String, doc: Document },
    InsertMany { collection: String, docs: Vec<Document> },
    UpdateOne { collection: String, filter: Document, update: Document, upsert: bool },
    UpdateMany { collection: String, filter: Document, update: Document, upsert: bool },
    ReplaceOne { collection: String, filter: Document, replacement: Document, upsert: bool },
    DeleteOne { collection: String, filter: Document },
    DeleteMany { collection: String, filter: Document },
    /// `db.runCommand({...})` — pass-through to the database command surface.
    RunCommand { command: Document },
    /// `db.getCollectionNames()` — admin helper, handled without a query.
    GetCollectionNames,
}

impl Command {
    /// True when this command reads rows (driven through `stream`), false
    /// when it's a write/admin op (driven through `execute`). The Tauri
    /// layer routes the same way for SQL — SELECT vs. the rest — so callers
    /// that already branch on "is this a read?" can reuse the answer.
    pub fn is_read(&self) -> bool {
        matches!(
            self,
            Command::Find { .. }
                | Command::FindOne { .. }
                | Command::Aggregate { .. }
                | Command::CountDocuments { .. }
                | Command::EstimatedDocumentCount { .. }
                | Command::Distinct { .. }
                | Command::RunCommand { .. }
                | Command::GetCollectionNames
        )
    }
}

/// A `.method(args)` segment split off the raw source.
struct Segment {
    method: String,
    /// Raw text between the matching parens, args still unparsed.
    args_src: String,
}

pub fn parse(src: &str) -> Result<Command> {
    let src = strip_comments(src);
    let trimmed = src.trim().trim_end_matches(';').trim();
    let rest = trimmed
        .strip_prefix("db")
        .ok_or(ParseError::NotADbCall)?;
    // `db` must be followed by `.` — reject `dbsomething`.
    let rest = rest.strip_prefix('.').ok_or(ParseError::NotADbCall)?;

    let segments = split_segments(rest)?;
    if segments.is_empty() {
        return Err(ParseError::NotADbCall);
    }

    // Two shapes:
    //   db.<helper>(...)             → first segment is a method, no collection
    //   db.<collection>.<method>(...) → first segment is a bare collection name
    //
    // We distinguish them by whether the first segment *has* a call. A bare
    // collection name (`db.users.find(...)`) parses as a leading identifier
    // with no parens, which `split_segments` returns as a method-less head.
    let (collection, call_segments) = split_collection(segments)?;

    match collection {
        // db.<helper>(...) form
        None => {
            let seg = &call_segments[0];
            match seg.method.as_str() {
                "runCommand" => {
                    let doc = parse_one_doc(seg, "runCommand")?;
                    Ok(Command::RunCommand { command: doc })
                }
                "getCollectionNames" => Ok(Command::GetCollectionNames),
                other => Err(ParseError::UnknownHelper(other.to_string())),
            }
        }
        // db.<collection>.<method>(...) form
        Some(coll) => parse_collection_call(coll, &call_segments),
    }
}

/// Decide whether the segment list begins with a bare collection identifier.
/// Returns the collection name (None for the `db.<helper>()` form) and the
/// remaining method-call segments.
fn split_collection(mut segments: Vec<Segment>) -> Result<(Option<String>, Vec<Segment>)> {
    let head = &segments[0];
    // A head with empty args_src AND the "bare" marker means it was an
    // identifier with no `(`. `split_segments` encodes that as args_src ==
    // sentinel "\0bare". The collection name then lives in `head.method`.
    if head.args_src == "\0bare" {
        let coll = head.method.clone();
        segments.remove(0);
        if segments.is_empty() {
            // `db.users` with no call — not something we run.
            return Err(ParseError::Syntax(
                "a collection name needs a method call, e.g. db.users.find({})".into(),
            ));
        }
        Ok((Some(coll), segments))
    } else {
        // First thing after `db.` is already a call → db helper form.
        Ok((None, segments))
    }
}

fn parse_collection_call(coll: String, segments: &[Segment]) -> Result<Command> {
    let head = &segments[0];
    let tail = &segments[1..];
    match head.method.as_str() {
        "find" => {
            let mut opts = FindOpts::default();
            let (filter, projection) = parse_filter_projection(head, "find")?;
            opts.filter = filter;
            opts.projection = projection;
            apply_find_modifiers(&mut opts, tail)?;
            Ok(Command::Find { collection: coll, opts })
        }
        "findOne" => {
            let (filter, projection) = parse_filter_projection(head, "findOne")?;
            reject_trailing(tail, "findOne")?;
            Ok(Command::FindOne { collection: coll, filter, projection })
        }
        "aggregate" => {
            let pipeline = parse_pipeline(head)?;
            reject_trailing(tail, "aggregate")?;
            Ok(Command::Aggregate { collection: coll, pipeline })
        }
        "count" | "countDocuments" => {
            let filter = parse_optional_doc(head, "countDocuments")?;
            reject_trailing(tail, "countDocuments")?;
            Ok(Command::CountDocuments { collection: coll, filter })
        }
        "estimatedDocumentCount" => {
            reject_trailing(tail, "estimatedDocumentCount")?;
            Ok(Command::EstimatedDocumentCount { collection: coll })
        }
        "distinct" => {
            let args = parse_args(&head.args_src)?;
            let field = match args.first() {
                Some(Bson::String(s)) => s.clone(),
                _ => return Err(ParseError::BadArgType {
                    method: "distinct".into(), idx: 0, expected: "a field-name string",
                }),
            };
            let filter = match args.get(1) {
                Some(Bson::Document(d)) => d.clone(),
                None => Document::new(),
                _ => return Err(ParseError::BadArgType {
                    method: "distinct".into(), idx: 1, expected: "a filter document",
                }),
            };
            reject_trailing(tail, "distinct")?;
            Ok(Command::Distinct { collection: coll, field, filter })
        }
        "insertOne" => {
            let doc = parse_one_doc(head, "insertOne")?;
            reject_trailing(tail, "insertOne")?;
            Ok(Command::InsertOne { collection: coll, doc })
        }
        "insertMany" => {
            let docs = parse_doc_array(head, "insertMany")?;
            reject_trailing(tail, "insertMany")?;
            Ok(Command::InsertMany { collection: coll, docs })
        }
        "updateOne" | "updateMany" => {
            let (filter, update, upsert) = parse_update(head)?;
            reject_trailing(tail, &head.method)?;
            if head.method == "updateOne" {
                Ok(Command::UpdateOne { collection: coll, filter, update, upsert })
            } else {
                Ok(Command::UpdateMany { collection: coll, filter, update, upsert })
            }
        }
        "replaceOne" => {
            let (filter, replacement, upsert) = parse_update(head)?;
            reject_trailing(tail, "replaceOne")?;
            Ok(Command::ReplaceOne { collection: coll, filter, replacement, upsert })
        }
        "deleteOne" => {
            let filter = parse_optional_doc(head, "deleteOne")?;
            reject_trailing(tail, "deleteOne")?;
            Ok(Command::DeleteOne { collection: coll, filter })
        }
        "deleteMany" => {
            let filter = parse_optional_doc(head, "deleteMany")?;
            reject_trailing(tail, "deleteMany")?;
            Ok(Command::DeleteMany { collection: coll, filter })
        }
        other => Err(ParseError::UnknownMethod(other.to_string())),
    }
}

// ───────────────────────── find modifiers ─────────────────────────

fn apply_find_modifiers(opts: &mut FindOpts, tail: &[Segment]) -> Result<()> {
    for seg in tail {
        match seg.method.as_str() {
            "sort" => opts.sort = Some(parse_one_doc(seg, "sort")?),
            "projection" => opts.projection = Some(parse_one_doc(seg, "projection")?),
            "limit" => opts.limit = Some(parse_i64_arg(seg, "limit")?),
            "skip" => opts.skip = Some(parse_i64_arg(seg, "skip")?.max(0) as u64),
            other => {
                return Err(ParseError::UnknownMethod(format!(
                    "{other} (after find: only sort/projection/limit/skip are supported)"
                )))
            }
        }
    }
    Ok(())
}

fn reject_trailing(tail: &[Segment], method: &str) -> Result<()> {
    if let Some(seg) = tail.first() {
        return Err(ParseError::Syntax(format!(
            "`.{}()` cannot be chained after `{method}`",
            seg.method
        )));
    }
    Ok(())
}

// ───────────────────────── argument parsing ─────────────────────────

fn parse_filter_projection(seg: &Segment, method: &str) -> Result<(Document, Option<Document>)> {
    let args = parse_args(&seg.args_src)?;
    let filter = match args.first() {
        None => Document::new(),
        Some(Bson::Document(d)) => d.clone(),
        Some(_) => return Err(ParseError::BadArgType {
            method: method.into(), idx: 0, expected: "a filter document",
        }),
    };
    let projection = match args.get(1) {
        None => None,
        Some(Bson::Document(d)) => Some(d.clone()),
        Some(_) => return Err(ParseError::BadArgType {
            method: method.into(), idx: 1, expected: "a projection document",
        }),
    };
    Ok((filter, projection))
}

/// `(filter, update_or_replacement, {upsert?})`. The third arg is the
/// options doc; we only read `upsert`.
fn parse_update(seg: &Segment) -> Result<(Document, Document, bool)> {
    let args = parse_args(&seg.args_src)?;
    if args.len() < 2 {
        return Err(ParseError::Arity {
            method: seg.method.clone(), expected: "2 or 3", got: args.len(),
        });
    }
    let filter = as_doc(&args[0], &seg.method, 0)?;
    let update = as_doc(&args[1], &seg.method, 1)?;
    let upsert = match args.get(2) {
        Some(Bson::Document(opts)) => matches!(opts.get("upsert"), Some(Bson::Boolean(true))),
        _ => false,
    };
    Ok((filter, update, upsert))
}

fn parse_pipeline(seg: &Segment) -> Result<Vec<Document>> {
    let args = parse_args(&seg.args_src)?;
    match args.into_iter().next() {
        Some(Bson::Array(arr)) => arr
            .into_iter()
            .map(|b| match b {
                Bson::Document(d) => Ok(d),
                _ => Err(ParseError::BadArgType {
                    method: "aggregate".into(), idx: 0, expected: "an array of stage documents",
                }),
            })
            .collect(),
        _ => Err(ParseError::BadArgType {
            method: "aggregate".into(), idx: 0, expected: "a pipeline array",
        }),
    }
}

fn parse_one_doc(seg: &Segment, method: &str) -> Result<Document> {
    let args = parse_args(&seg.args_src)?;
    match args.into_iter().next() {
        Some(Bson::Document(d)) => Ok(d),
        Some(_) => Err(ParseError::BadArgType { method: method.into(), idx: 0, expected: "a document" }),
        None => Err(ParseError::Arity { method: method.into(), expected: "1", got: 0 }),
    }
}

/// A document argument that defaults to `{}` when omitted (filters).
fn parse_optional_doc(seg: &Segment, method: &str) -> Result<Document> {
    let args = parse_args(&seg.args_src)?;
    match args.into_iter().next() {
        None => Ok(Document::new()),
        Some(Bson::Document(d)) => Ok(d),
        Some(_) => Err(ParseError::BadArgType { method: method.into(), idx: 0, expected: "a document" }),
    }
}

fn parse_doc_array(seg: &Segment, method: &str) -> Result<Vec<Document>> {
    let args = parse_args(&seg.args_src)?;
    match args.into_iter().next() {
        Some(Bson::Array(arr)) => arr
            .into_iter()
            .map(|b| match b {
                Bson::Document(d) => Ok(d),
                _ => Err(ParseError::BadArgType { method: method.into(), idx: 0, expected: "an array of documents" }),
            })
            .collect(),
        _ => Err(ParseError::BadArgType { method: method.into(), idx: 0, expected: "an array of documents" }),
    }
}

fn parse_i64_arg(seg: &Segment, method: &str) -> Result<i64> {
    let args = parse_args(&seg.args_src)?;
    match args.first() {
        Some(Bson::Int32(n)) => Ok(*n as i64),
        Some(Bson::Int64(n)) => Ok(*n),
        Some(Bson::Double(f)) => Ok(*f as i64),
        _ => Err(ParseError::BadArgType { method: method.into(), idx: 0, expected: "an integer" }),
    }
}

fn as_doc(b: &Bson, method: &str, idx: usize) -> Result<Document> {
    match b {
        Bson::Document(d) => Ok(d.clone()),
        _ => Err(ParseError::BadArgType { method: method.into(), idx, expected: "a document" }),
    }
}

/// Parse the comma-separated argument list of one call. We wrap the raw
/// source in `[ ... ]` and run it through the relaxed JSON reader, which
/// gives us an array of argument values in order. Empty args → empty vec.
fn parse_args(args_src: &str) -> Result<Vec<Bson>> {
    let trimmed = args_src.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    let wrapped = format!("[{trimmed}]");
    let json = relaxed_to_json(&wrapped)?;
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| ParseError::Json(e.to_string()))?;
    match value {
        serde_json::Value::Array(items) => Ok(items
            .into_iter()
            .map(json_to_bson)
            .collect()),
        _ => unreachable!("we wrapped in [] above"),
    }
}

// ───────────────────────── source splitting ─────────────────────────

/// Strip `//` line comments and `/* */` block comments. nosqlbooster lets
/// people annotate queries; we drop the comments before parsing rather than
/// choke on them. String literals are respected so a `//` inside a value
/// survives.
fn strip_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let mut in_str: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_str {
            out.push(c as char);
            if c == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == q {
                in_str = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' => {
                in_str = Some(c);
                out.push(c as char);
                i += 1;
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    out
}

/// Walk `<ident>(<args>)<ident>(<args>)...` (with `.` separators) and split
/// into segments. A leading bare identifier with no call is returned as a
/// segment whose `args_src` is the sentinel `"\0bare"` — that's how the
/// caller knows the first token was a collection name, not a method.
///
/// Depth tracking respects nesting and string literals so commas/parens
/// inside argument documents don't confuse the split.
fn split_segments(mut s: &str) -> Result<Vec<Segment>> {
    let mut out = Vec::new();
    loop {
        s = s.trim_start();
        if s.is_empty() {
            break;
        }
        // Read an identifier (method or collection name). Collection names
        // can contain dots in mongo, but our `db.coll.method` split already
        // consumed one dot level; we stop the identifier at `.` or `(`.
        let ident_end = s.find(['.', '(']).unwrap_or(s.len());
        let ident = s[..ident_end].trim().to_string();
        if ident.is_empty() {
            return Err(ParseError::Syntax("empty identifier in call chain".into()));
        }
        let after = &s[ident_end..];
        if let Some(rest) = after.strip_prefix('(') {
            // Find the matching close paren.
            let (args, remainder) = take_balanced(rest)?;
            out.push(Segment { method: ident, args_src: args });
            // Skip an optional `.` joining to the next segment.
            s = remainder.trim_start().strip_prefix('.').unwrap_or(remainder);
        } else if let Some(rest) = after.strip_prefix('.') {
            // A bare identifier (collection) followed by another segment.
            out.push(Segment { method: ident, args_src: "\0bare".into() });
            s = rest;
        } else {
            // Bare identifier with nothing after — e.g. `db.users`.
            out.push(Segment { method: ident, args_src: "\0bare".into() });
            s = "";
        }
    }
    Ok(out)
}

/// Given source positioned just after an opening `(`, return the text up to
/// the matching `)` and the remainder after it. Respects nested parens,
/// brackets, braces, and string literals.
fn take_balanced(s: &str) -> Result<(String, &str)> {
    let bytes = s.as_bytes();
    let mut depth = 1i32;
    let mut i = 0;
    let mut in_str: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                in_str = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' => in_str = Some(c),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    let args = s[..i].to_string();
                    return Ok((args, &s[i + 1..]));
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(ParseError::Syntax("unbalanced parentheses".into()))
}

// ───────────────────────── relaxed JSON ─────────────────────────

/// Convert shell-style relaxed JSON into strict JSON that serde_json can
/// read: quote unquoted object keys, normalise single-quoted strings to
/// double-quoted, and drop trailing commas. This is a tokenizer-level
/// rewrite, not a full parser — it only needs to make the input strict
/// enough for serde_json to take over.
///
/// We intentionally do NOT try to evaluate shell constructors like
/// `ObjectId("…")` or `ISODate("…")` here — those would need real value
/// types. They are rare in the editor's day-to-day filters; if someone
/// pastes one, serde_json reports a clear parse error pointing at it,
/// which beats silently mis-parsing.
fn relaxed_to_json(src: &str) -> Result<String> {
    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'"' => {
                // Copy a double-quoted string verbatim.
                out.push('"');
                i += 1;
                while i < bytes.len() {
                    let d = bytes[i];
                    out.push(d as char);
                    if d == b'\\' && i + 1 < bytes.len() {
                        out.push(bytes[i + 1] as char);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    if d == b'"' {
                        break;
                    }
                }
            }
            b'\'' => {
                // Single-quoted → double-quoted, escaping inner double quotes.
                out.push('"');
                i += 1;
                while i < bytes.len() {
                    let d = bytes[i];
                    if d == b'\\' && i + 1 < bytes.len() {
                        out.push('\\');
                        out.push(bytes[i + 1] as char);
                        i += 2;
                        continue;
                    }
                    if d == b'\'' {
                        i += 1;
                        break;
                    }
                    if d == b'"' {
                        out.push('\\');
                    }
                    out.push(d as char);
                    i += 1;
                }
                out.push('"');
            }
            // Unquoted identifier: either an object key (followed by `:`) or
            // a bareword literal. Mongo keys and operators (`$gt`, `_id`,
            // `a.b`) are identifier-ish; quote them. true/false/null pass
            // through as JSON literals.
            c if is_ident_start(c) => {
                let start = i;
                while i < bytes.len() && is_ident_part(bytes[i]) {
                    i += 1;
                }
                let word = &src[start..i];
                if matches!(word, "true" | "false" | "null") {
                    out.push_str(word);
                } else {
                    // Quote it — covers unquoted keys and would-be barewords.
                    out.push('"');
                    out.push_str(word);
                    out.push('"');
                }
            }
            b',' => {
                // Drop trailing commas: peek past whitespace for a closer.
                let mut j = i + 1;
                while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && matches!(bytes[j], b'}' | b']') {
                    i += 1; // skip the comma
                } else {
                    out.push(',');
                    i += 1;
                }
            }
            _ => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    Ok(out)
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}
fn is_ident_part(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c == b'.'
}

/// serde_json::Value → Bson. We lean on bson's own conversion which already
/// knows how to fold `{"$oid": "..."}` extended-JSON forms back into typed
/// BSON, so pasted extended JSON from nosqlbooster's export round-trips.
fn json_to_bson(v: serde_json::Value) -> Bson {
    Bson::try_from(v).unwrap_or(Bson::Null)
}
