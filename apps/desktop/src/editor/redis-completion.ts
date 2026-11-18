import { LanguageSupport, StreamLanguage, type StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SchemaTree } from "@/ipc/types";

/** Common commands, grouped roughly by data type, with a one-line hint. Not
 *  exhaustive — the server accepts anything; this is just for completion. */
const COMMANDS: [string, string][] = [
  // keys
  ["GET", "GET key"], ["SET", "SET key value [EX s]"], ["DEL", "DEL key [key …]"],
  ["EXISTS", "EXISTS key [key …]"], ["TYPE", "TYPE key"], ["TTL", "TTL key"],
  ["EXPIRE", "EXPIRE key seconds"], ["PERSIST", "PERSIST key"], ["RENAME", "RENAME key newkey"],
  ["SCAN", "SCAN cursor [MATCH pattern] [COUNT n] [TYPE t]"], ["KEYS", "KEYS pattern — blocks on big databases; prefer SCAN"],
  ["INCR", "INCR key"], ["INCRBY", "INCRBY key n"], ["DECR", "DECR key"], ["MGET", "MGET key [key …]"],
  ["MSET", "MSET key value [key value …]"], ["APPEND", "APPEND key value"], ["STRLEN", "STRLEN key"],
  ["UNLINK", "UNLINK key [key …]"], ["OBJECT", "OBJECT ENCODING|FREQ|IDLETIME key"], ["DUMP", "DUMP key"],
  // hashes
  ["HGET", "HGET key field"], ["HSET", "HSET key field value [field value …]"], ["HGETALL", "HGETALL key"],
  ["HDEL", "HDEL key field [field …]"], ["HKEYS", "HKEYS key"], ["HVALS", "HVALS key"], ["HLEN", "HLEN key"],
  ["HSCAN", "HSCAN key cursor [MATCH pattern] [COUNT n]"], ["HINCRBY", "HINCRBY key field n"],
  // lists
  ["LRANGE", "LRANGE key start stop"], ["LPUSH", "LPUSH key value [value …]"], ["RPUSH", "RPUSH key value [value …]"],
  ["LPOP", "LPOP key [count]"], ["RPOP", "RPOP key [count]"], ["LLEN", "LLEN key"], ["LINDEX", "LINDEX key index"],
  ["LTRIM", "LTRIM key start stop"],
  // sets
  ["SMEMBERS", "SMEMBERS key"], ["SADD", "SADD key member [member …]"], ["SREM", "SREM key member [member …]"],
  ["SCARD", "SCARD key"], ["SISMEMBER", "SISMEMBER key member"], ["SSCAN", "SSCAN key cursor [MATCH pattern] [COUNT n]"],
  // sorted sets
  ["ZRANGE", "ZRANGE key start stop [BYSCORE|BYLEX] [REV] [WITHSCORES]"], ["ZADD", "ZADD key score member [score member …]"],
  ["ZREM", "ZREM key member [member …]"], ["ZCARD", "ZCARD key"], ["ZSCORE", "ZSCORE key member"],
  ["ZINCRBY", "ZINCRBY key n member"], ["ZSCAN", "ZSCAN key cursor [MATCH pattern] [COUNT n]"],
  // streams
  ["XRANGE", "XRANGE key start end [COUNT n]"], ["XREVRANGE", "XREVRANGE key end start [COUNT n]"],
  ["XADD", "XADD key id|* field value [field value …]"], ["XLEN", "XLEN key"], ["XINFO", "XINFO STREAM key"],
  // server
  ["PING", "PING"], ["INFO", "INFO [section]"], ["DBSIZE", "DBSIZE"], ["CONFIG", "CONFIG GET parameter"],
  ["CLIENT", "CLIENT LIST|INFO"], ["SLOWLOG", "SLOWLOG GET [n]"], ["MEMORY", "MEMORY USAGE key"],
  ["SELECT", "SELECT index — for this query only"], ["FLUSHDB", "FLUSHDB — deletes every key in this database"],
  // transactions & scripting
  ["MULTI", "MULTI"], ["EXEC", "EXEC"], ["DISCARD", "DISCARD"], ["EVAL", "EVAL script numkeys [key …] [arg …]"],
];

const COMMAND_OPTIONS: Completion[] = COMMANDS.map(([label, info]) => ({
  label, type: "keyword", info,
}));

/** Highlighting: the first word of a line is the command, then strings,
 *  numbers, and `#` / `//` comment lines. Mirrors the db-redis tokenizer. */
const redisLanguage = StreamLanguage.define<{ atStart: boolean }>({
  name: "redis",
  startState: () => ({ atStart: true }),
  token(stream: StringStream, state) {
    if (stream.sol()) state.atStart = true;
    if (stream.eatSpace()) return null;
    if (state.atStart && (stream.match("#") || stream.match("//"))) {
      stream.skipToEnd();
      return "comment";
    }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      let escaped = false;
      for (let ch = stream.next(); ch != null; ch = stream.next()) {
        if (ch === quote && !escaped) break;
        escaped = !escaped && ch === "\\";
      }
      state.atStart = false;
      return "string";
    }
    stream.eatWhile(/\S/);
    const word = stream.current();
    if (state.atStart) {
      state.atStart = false;
      return "keyword";
    }
    return /^-?\d+(\.\d+)?$/.test(word) ? "number" : null;
  },
  languageData: { commentTokens: { line: "#" } },
});

/** Editor support for Redis: highlighting plus completion of command names
 *  (first word on a line) and the key names from the schema tree (after). */
export function buildRedisExtension(tree: SchemaTree | undefined): Extension {
  const keys: Completion[] = [];
  const seen = new Set<string>();
  for (const db of tree?.databases ?? []) {
    for (const sc of db.schemas) {
      for (const t of sc.tables) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        keys.push({ label: t.name, type: "variable", detail: t.columns[0]?.type_name });
      }
    }
  }

  const source = (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[^\s"']*/);
    if (!word) return null;
    if (word.from === word.to && !ctx.explicit) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const isFirstWord = line.text.slice(0, word.from - line.from).trim() === "";
    return {
      from: word.from,
      options: isFirstWord ? COMMAND_OPTIONS : keys,
      validFor: /^[^\s"']*$/,
    };
  };

  return new LanguageSupport(redisLanguage, redisLanguage.data.of({ autocomplete: source }));
}
