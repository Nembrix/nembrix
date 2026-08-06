import { describe, it, expect } from "vitest";
import { parseMongoUri, buildMongoUri } from "./mongoUri";
import type { ConnectionInput } from "@/ipc/types";

const base: ConnectionInput = {
  id: null, name: "", engine: "mongo", host: "127.0.0.1", port: 27017,
  username: "", password: "", database: "", ssl_mode: "disable",
  ssh: null, color: null, environment: "development",
};

describe("parseMongoUri", () => {
  it("parses a full mongodb:// URI", () => {
    const r = parseMongoUri("mongodb://alice:s3cret@db.example.com:27018/shop");
    expect(r).toMatchObject({
      host: "db.example.com",
      port: 27018,
      username: "alice",
      password: "s3cret",
      database: "shop",
    });
  });

  it("defaults the port when omitted", () => {
    const r = parseMongoUri("mongodb://localhost/mydb");
    expect(r?.host).toBe("localhost");
    expect(r?.database).toBe("mydb");
    // no port in the string → parser leaves it unset (form keeps its default)
    expect(r?.port).toBeUndefined();
  });

  it("turns on TLS for tls=true and for mongodb+srv", () => {
    expect(parseMongoUri("mongodb://h:27017/db?tls=true")?.ssl_mode).toBe("require");
    expect(parseMongoUri("mongodb+srv://user:p@cluster.mongodb.net/db")?.ssl_mode).toBe("require");
    expect(parseMongoUri("mongodb://h:27017/db")?.ssl_mode).toBe("disable");
  });

  it("keeps only the first host of a replica-set list", () => {
    const r = parseMongoUri("mongodb://u:p@h1:27017,h2:27017,h3:27017/db");
    expect(r?.host).toBe("h1");
    expect(r?.port).toBe(27017);
  });

  it("percent-decodes user and password", () => {
    const r = parseMongoUri("mongodb://a%40b:p%3Ass@host/db");
    expect(r?.username).toBe("a@b");
    expect(r?.password).toBe("p:ss");
  });

  it("returns null for a non-Mongo URI", () => {
    expect(parseMongoUri("postgres://x@h/db")).toBeNull();
    expect(parseMongoUri("not a uri")).toBeNull();
    expect(parseMongoUri("")).toBeNull();
  });
});

describe("buildMongoUri", () => {
  it("builds from form values and omits the password", () => {
    const v = { ...base, username: "alice", password: "secret", host: "h", port: 27018, database: "shop" };
    const uri = buildMongoUri(v);
    expect(uri).toBe("mongodb://alice@h:27018/shop");
    expect(uri).not.toContain("secret");
  });

  it("adds tls=true when ssl_mode isn't disable", () => {
    const v: ConnectionInput = { ...base, host: "h", port: 27017, database: "db", ssl_mode: "require" };
    expect(buildMongoUri(v)).toContain("tls=true");
  });
});
