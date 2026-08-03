import { useEffect, useRef, useState } from "react";
import { Database, FileKey, X } from "lucide-react";
import * as api from "@/ipc/commands";
import { isTauri } from "@/ipc/commands";
import type { ConnectionInput, ConnectionRecord, Environment } from "@/ipc/types";
import { useStore } from "@/store";
import { ENV_COLOR, ENV_LABEL, ENVIRONMENTS, colorFor } from "./environment";
import { validateConnectionName } from "./validateConnectionName";

/** Engines we ship now vs. the ones on the roadmap. The form lists every
 *  engine — the unsupported ones are shown disabled with a "Coming soon"
 *  tag so the product roadmap is visible to the user without letting
 *  them try to connect with a driver that doesn't exist yet. */
type EngineKey = "postgres" | "mysql" | "sqlite" | "mongo" | "redis";
const ENGINES: { key: EngineKey; label: string; supported: boolean }[] = [
  { key: "postgres", label: "PostgreSQL", supported: true },
  { key: "mysql",    label: "MySQL",      supported: false },
  { key: "sqlite",   label: "SQLite",     supported: false },
  { key: "mongo",    label: "MongoDB",    supported: true },
  { key: "redis",    label: "Redis",      supported: false },
];

/** The well-known default port per engine, applied when the user switches
 *  engines so they don't have to remember 27017 vs 5432. */
const DEFAULT_PORT: Record<EngineKey, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
  mongo: 27017,
  redis: 6379,
};

/** Build a libpq-style URI from the current form values. The password
 *  is intentionally omitted from the *display* string (Test/Connect
 *  still uses the password field) — pasted URIs include passwords, but
 *  rendering them back in a visible field is a security smell. */
function buildPostgresUri(v: ConnectionInput): string {
  const user = encodeURIComponent(v.username || "");
  const host = v.host || "";
  const port = v.port || 5432;
  const db = v.database ? `/${encodeURIComponent(v.database)}` : "";
  const params: string[] = [];
  if (v.ssl_mode && v.ssl_mode !== "prefer") params.push(`sslmode=${v.ssl_mode}`);
  const q = params.length ? `?${params.join("&")}` : "";
  return `postgresql://${user}${user ? "@" : ""}${host}:${port}${db}${q}`;
}

/** Parse a postgres:// or postgresql:// URI into a partial input.
 *  Returns null when the string isn't a recognisable Postgres URI so
 *  the caller can show a "couldn't parse" hint rather than silently
 *  blanking the form. */
function parsePostgresUri(raw: string): Partial<ConnectionInput> | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^postgres(ql)?:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const out: Partial<ConnectionInput> = {};
  if (u.hostname) out.host = u.hostname;
  if (u.port) out.port = parseInt(u.port, 10) || 5432;
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const path = u.pathname.replace(/^\//, "");
  if (path) out.database = decodeURIComponent(path);
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode === "disable" || sslmode === "prefer" || sslmode === "require") {
    out.ssl_mode = sslmode;
  }
  return out;
}

const empty: ConnectionInput = {
  id: null,
  name: "",
  engine: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "",
  database: "postgres",
  ssl_mode: "prefer",
  ssh: null,
  color: null,
  environment: "development",
};

function recordToInput(c: ConnectionRecord): ConnectionInput {
  return {
    id: c.id,
    name: c.name,
    engine: (c.engine as ConnectionInput["engine"]) || "postgres",
    host: c.host,
    port: c.port,
    username: c.username,
    password: "", // never read back from the keychain into the form
    database: c.database,
    ssl_mode: (c.ssl_mode as ConnectionInput["ssl_mode"]) || "prefer",
    ssh: c.ssh
      ? {
          host: c.ssh.host, port: c.ssh.port, user: c.ssh.user,
          auth_kind: c.ssh.auth_kind as never,
          password: null,
          key_path: c.ssh.key_path,
          // The on-disk record never stores the inline private key
          // body — that lives in the keychain. Form prefills with null
          // so the user can paste a fresh one if needed.
          key_data: null,
          key_passphrase: null,
          strict_host_key: c.ssh.strict_host_key,
        }
      : null,
    color: c.color,
    environment: c.environment ?? "development",
  };
}

export default function ConnectionForm({ onClose }: { onClose: () => void }) {
  const { setConnections, connections, connectionFormEditingId, openSession } = useStore();
  const editing = connectionFormEditingId
    ? connections.find((c) => c.id === connectionFormEditingId)
    : null;

  const [v, setV] = useState<ConnectionInput>(editing ? recordToInput(editing) : empty);
  const [useSsh, setUseSsh] = useState(!!editing?.ssh);
  /** Whether the user is filling individual fields or pasting a full
   *  Postgres URI. The URI is the source of truth in "url" mode and
   *  the fields are derived; in "form" mode it's the other way round. */
  const [inputMode, setInputMode] = useState<"form" | "url">("form");
  const [uriText, setUriText] = useState<string>("");
  const [uriErr, setUriErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  // Only surface the inline name error once the field has been touched or
  // a save was attempted, so a freshly-opened form doesn't show a red
  // "required" hint before the user has done anything.
  const [nameTouched, setNameTouched] = useState(false);
  // Quick visual ack on the Test button: tints it green/red for ~2.5s
  // after a probe completes so the user catches the result without
  // reading the small status text. Cleared whenever the form changes
  // so a green button never lies about a stale test.
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  // Disable every action button while any single one is in flight so
  // the user can't double-click Save during a slow Test, etc.
  const [working, setWorking] = useState<null | "test" | "save" | "connect">(null);

  // Re-prefill if the editing target changes while the modal is open.
  useEffect(() => {
    if (editing) {
      setV(recordToInput(editing));
      setUseSsh(!!editing.ssh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionFormEditingId]);

  const patch = (p: Partial<ConnectionInput>) => setV((s) => ({ ...s, ...p }));

  const onUriChange = (text: string) => {
    setUriText(text);
    if (!text.trim()) { setUriErr(null); return; }
    const parsed = parsePostgresUri(text);
    if (!parsed) {
      setUriErr("Not a recognisable Postgres URI (expected postgres://user:pass@host:port/db).");
      return;
    }
    setUriErr(null);
    setV((s) => ({ ...s, ...parsed }));
  };

  const switchToUri = () => {
    setUriText(buildPostgresUri(v));
    setUriErr(null);
    setInputMode("url");
  };
  const patchSsh = (p: Partial<NonNullable<ConnectionInput["ssh"]>>) =>
    setV((s) => ({
      ...s,
      ssh: {
        host: "",
        port: 22,
        user: "",
        auth_kind: "password",
        password: null,
        key_path: null,
        key_data: null,
        key_passphrase: null,
        strict_host_key: false,
        ...(s.ssh ?? {}),
        ...p,
      },
    }));

  const finalInput = (): ConnectionInput => ({ ...v, ssh: useSsh ? v.ssh : null });

  // Validate the connection name up front (required + unique). Gates Save
  // / Connect so we never round-trip an invalid record to the backend just
  // to get a generic error back. See validateConnectionName above.
  const nameError = validateConnectionName(v.name, connections, v.id);

  const onTest = async () => {
    setWorking("test");
    setTestMsg("Testing…");
    setTestResult(null);
    try {
      const ms = await api.testConnection(finalInput());
      setTestMsg(`OK · ${ms} ms`);
      setTestResult("ok");
    } catch (e) {
      setTestMsg(`Failed: ${e}`);
      setTestResult("fail");
    } finally {
      setWorking(null);
    }
  };

  // Drop the result tint a beat after it appears so the button doesn't
  // sit green forever. 2.5s is long enough to register the change, short
  // enough that the next Test starts from a neutral baseline.
  useEffect(() => {
    if (!testResult) return;
    const t = setTimeout(() => setTestResult(null), 2500);
    return () => clearTimeout(t);
  }, [testResult]);

  // Any form edit invalidates the test result — the green button
  // shouldn't lie about a probe that ran against different credentials.
  // We skip the very first render so loading an existing connection
  // for edit doesn't immediately strip a result the user hasn't seen
  // yet (defensive — there is no result on first render anyway).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    setTestResult(null);
    setTestMsg(null);
  }, [v, useSsh]);

  const onSave = async () => {
    if (nameError) { setNameTouched(true); setTestMsg(nameError); setTestResult("fail"); return; }
    setWorking("save");
    try {
      await api.saveConnection(finalInput());
      setConnections(await api.listConnections());
      onClose();
    } catch (e) {
      setTestMsg(`Save failed: ${e}`);
      setWorking(null);
    }
  };

  /**
   * Save + open a session + connect, in one user action. Replaces the
   * old two-step (Save → close → click connect in the rail). Mirrors
   * the ConnectionManagerDialog's connectNow flow so the connection
   * lifecycle is consistent.
   */
  const onSaveAndConnect = async () => {
    if (nameError) { setNameTouched(true); setTestMsg(nameError); setTestResult("fail"); return; }
    setWorking("connect");
    setTestMsg("Saving…");
    try {
      const saved = await api.saveConnection(finalInput());
      setConnections(await api.listConnections());
      const sessionId = openSession(saved.id);
      const store = useStore.getState();
      store.setStatus(sessionId, "connecting");
      setTestMsg("Connecting…");
      try {
        await api.connect(saved.id);
        store.setStatus(sessionId, "connected");
        const tree = await api.introspect(saved.id);
        store.setSchema(sessionId, tree);
        onClose();
      } catch (e) {
        // Save already succeeded, so leave the connection in the list
        // but flag the session as errored and surface the message —
        // the user can hit Retry from the rail without re-entering
        // credentials.
        store.setStatus(sessionId, "error");
        setTestMsg(`Connect failed: ${e}`);
        setWorking(null);
      }
    } catch (e) {
      setTestMsg(`Save failed: ${e}`);
      setWorking(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Database size={15} />
          <span>{editing
            ? `Edit ${editing.name}`
            : `New ${ENGINES.find((e) => e.key === v.engine)?.label ?? "database"} connection`}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="section-title">Engine</div>
            <label htmlFor="cf-engine">Database</label>
            <select
              id="cf-engine"
              value={v.engine}
              onChange={(e) => {
                const next = e.target.value as ConnectionInput["engine"];
                const found = ENGINES.find((g) => g.key === next);
                if (!found?.supported) return;
                // Snap the port to the new engine's default, but only if the
                // current port is still some engine's default (i.e. the user
                // hasn't typed a custom one we'd be clobbering).
                const portIsDefault = Object.values(DEFAULT_PORT).includes(v.port);
                patch({
                  engine: next,
                  ...(portIsDefault ? { port: DEFAULT_PORT[next as EngineKey] } : {}),
                });
              }}
            >
              {ENGINES.map((e) => (
                <option key={e.key} value={e.key} disabled={!e.supported}>
                  {e.label}{e.supported ? "" : " — Coming soon"}
                </option>
              ))}
            </select>

            <div className="section-title">General</div>
            <label htmlFor="cf-name">Name</label>
            <div>
              <input
                id="cf-name"
                type="text"
                value={v.name}
                aria-invalid={nameTouched && !!nameError}
                className={nameTouched && nameError ? "invalid" : undefined}
                onChange={(e) => patch({ name: e.target.value })}
                onBlur={() => setNameTouched(true)}
              />
              {nameTouched && nameError && (
                <div className="field-error">{nameError}</div>
              )}
            </div>

            {v.engine === "postgres" && (
              <>
                <label>Input</label>
                <div className="cf-mode-toggle">
                  <button
                    type="button"
                    className={`btn-pill ${inputMode === "form" ? "primary" : ""}`}
                    onClick={() => setInputMode("form")}
                  >Fields</button>
                  <button
                    type="button"
                    className={`btn-pill ${inputMode === "url" ? "primary" : ""}`}
                    onClick={switchToUri}
                  >Connection URL</button>
                </div>
              </>
            )}

            {inputMode === "url" && v.engine === "postgres" ? (
              <>
                <label htmlFor="cf-uri">URL</label>
                <div>
                  <textarea
                    id="cf-uri"
                    className="cf-uri-input"
                    rows={2}
                    spellCheck={false}
                    placeholder="postgresql://user:password@host:5432/dbname?sslmode=require"
                    value={uriText}
                    onChange={(e) => onUriChange(e.target.value)}
                  />
                  {uriErr && <div className="cf-uri-err">{uriErr}</div>}
                  {!uriErr && uriText && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      Parsed → {v.username || "(no user)"}@{v.host}:{v.port}
                      {v.database ? `/${v.database}` : ""}
                      {v.ssl_mode && v.ssl_mode !== "prefer" ? ` · sslmode=${v.ssl_mode}` : ""}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <label htmlFor="cf-host">Host</label>
                <input id="cf-host" type="text" value={v.host} onChange={(e) => patch({ host: e.target.value })} />
                <label htmlFor="cf-port">Port</label>
                <input id="cf-port" type="number" value={v.port}
                  onChange={(e) => patch({ port: parseInt(e.target.value || "0") })} />
                <label htmlFor="cf-user">User</label>
                <input id="cf-user" type="text" value={v.username} onChange={(e) => patch({ username: e.target.value })} />
                <label htmlFor="cf-password">Password</label>
                <input id="cf-password" type="password" value={v.password ?? ""}
                  onChange={(e) => patch({ password: e.target.value })} />
                <label htmlFor="cf-database">Database</label>
                <input id="cf-database" type="text" value={v.database ?? ""}
                  onChange={(e) => patch({ database: e.target.value || null })} />
                <label htmlFor="cf-ssl">SSL</label>
                <select id="cf-ssl" value={v.ssl_mode}
                  onChange={(e) => patch({ ssl_mode: e.target.value as never })}>
                  <option value="disable">disable</option>
                  <option value="prefer">prefer</option>
                  <option value="require">require</option>
                </select>
              </>
            )}

            <div className="section-title">Group</div>
            <label htmlFor="cf-group">Group</label>
            <input
              id="cf-group"
              type="text"
              list="cf-group-options"
              placeholder="e.g. Acme · Team Foo · Personal — blank for ungrouped"
              value={v.group ?? ""}
              onChange={(e) => patch({ group: e.target.value || null })}
            />
            <datalist id="cf-group-options">
              {Array.from(new Set(
                useStore.getState().connections
                  .map((c) => c.group)
                  .filter((g): g is string => !!g),
              )).map((g) => (<option key={g} value={g} />))}
            </datalist>

            <div className="section-title">Environment</div>
            <label htmlFor="cf-env">Type</label>
            <select
              id="cf-env"
              value={v.environment ?? "development"}
              onChange={(e) => {
                const env = e.target.value as Environment;
                // If the user hasn't customized the color, snap it to the env default.
                const stickColor = v.color && v.color !== ENV_COLOR[(v.environment ?? "development")];
                patch({
                  environment: env,
                  color: stickColor ? v.color : ENV_COLOR[env],
                });
              }}
            >
              {ENVIRONMENTS.map((env) => (
                <option key={env} value={env}>{ENV_LABEL[env]}</option>
              ))}
            </select>
            <label>Color</label>
            <div className="env-color-row">
              {Object.entries(ENV_COLOR).map(([envKey, hex]) => (
                <button
                  key={envKey}
                  type="button"
                  className={`env-swatch ${(v.color ?? ENV_COLOR[v.environment ?? "development"]) === hex ? "selected" : ""}`}
                  style={{ background: hex }}
                  title={`${envKey} default`}
                  onClick={() => patch({ color: hex })}
                />
              ))}
              <input
                type="color"
                aria-label="Custom color"
                className="env-color-custom"
                value={colorFor(v.environment, v.color)}
                onChange={(e) => patch({ color: e.target.value })}
              />
            </div>

            <div className="section-title">SSH tunnel</div>
            <label htmlFor="cf-ssh">Use SSH</label>
            <div>
              <input id="cf-ssh" type="checkbox" checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} />
            </div>
            {useSsh && (<>
              <label htmlFor="cf-ssh-host">SSH host</label>
              <input id="cf-ssh-host" type="text" value={v.ssh?.host ?? ""}
                onChange={(e) => patchSsh({ host: e.target.value })} />
              <label htmlFor="cf-ssh-port">SSH port</label>
              <input id="cf-ssh-port" type="number" value={v.ssh?.port ?? 22}
                onChange={(e) => patchSsh({ port: parseInt(e.target.value || "22") })} />
              <label htmlFor="cf-ssh-user">SSH user</label>
              <input id="cf-ssh-user" type="text" value={v.ssh?.user ?? ""}
                onChange={(e) => patchSsh({ user: e.target.value })} />
              <label htmlFor="cf-ssh-auth">Auth</label>
              <select id="cf-ssh-auth" value={v.ssh?.auth_kind ?? "password"}
                onChange={(e) => patchSsh({ auth_kind: e.target.value as never })}>
                <option value="password">password</option>
                <option value="key_file">key file</option>
                <option value="agent">ssh-agent</option>
              </select>
              {v.ssh?.auth_kind === "password" && (<>
                <label htmlFor="cf-ssh-pw">SSH password</label>
                <input id="cf-ssh-pw" type="password" value={v.ssh?.password ?? ""}
                  onChange={(e) => patchSsh({ password: e.target.value })} />
              </>)}
              {v.ssh?.auth_kind === "key_file" && (<>
                <label>Key file</label>
                <SshKeyPicker
                  keyPath={v.ssh?.key_path ?? null}
                  keyData={v.ssh?.key_data ?? null}
                  onPath={(p) => patchSsh({ key_path: p, key_data: null })}
                  onData={(name, content) => patchSsh({ key_path: name, key_data: content })}
                  onClear={() => patchSsh({ key_path: null, key_data: null })}
                />
                <label htmlFor="cf-ssh-keypass">Passphrase</label>
                <input id="cf-ssh-keypass" type="password" value={v.ssh?.key_passphrase ?? ""}
                  onChange={(e) => patchSsh({ key_passphrase: e.target.value || null })} />
              </>)}
              <label htmlFor="cf-ssh-strict">Strict host key</label>
              <div>
                <input id="cf-ssh-strict" type="checkbox"
                  checked={v.ssh?.strict_host_key ?? false}
                  onChange={(e) => patchSsh({ strict_host_key: e.target.checked })} />
              </div>
            </>)}
          </div>
        </div>
        <div className="modal-footer">
          <button
            className={`btn-pill test-btn ${testResult === "ok" ? "test-ok" : ""} ${testResult === "fail" ? "test-fail" : ""}`}
            onClick={onTest}
            disabled={!!working}
          >
            {working === "test"
              ? "Testing…"
              : testResult === "ok"
                ? "✓ Passed"
                : testResult === "fail"
                  ? "✕ Failed"
                  : "Test"}
          </button>
          {testMsg && (
            <span className={
              testResult === "ok" ? "test-msg ok"
                : testResult === "fail" ? "test-msg fail"
                : "muted"
            }>
              {testMsg}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose} disabled={!!working}>Cancel</button>
          <button
            className="btn-pill"
            onClick={onSave}
            disabled={!!working || !!nameError}
            title={nameError ?? undefined}
          >
            {working === "save"
              ? (editing ? "Updating…" : "Saving…")
              : (editing ? "Update" : "Save")}
          </button>
          <button
            className="btn-pill primary"
            onClick={onSaveAndConnect}
            disabled={!!working || !!nameError}
            title={nameError ?? (editing
              ? "Update this connection and connect to it"
              : "Save this connection and connect to it now")}
          >
            {working === "connect" ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── SSH key picker ─────────────────────────
   Two modes:
   - Tauri: opens the native file dialog, sets key_path to the chosen FS path.
   - Browser: a hidden <input type="file"> with a Browse button reads the
     file contents in-memory and stores them on the connection record. The
     Rust SSH bridge will materialize this to a temp file before handing to
     russh — for browser-mode the mock backend doesn't actually open a
     tunnel, so the data just round-trips for visual confirmation.
*/
function SshKeyPicker({
  keyPath, keyData, onPath, onData, onClear,
}: {
  keyPath: string | null;
  keyData: string | null;
  onPath: (path: string) => void;
  onData: (filename: string, content: string) => void;
  onClear: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const pickViaTauri = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const home = await (async () => {
        try {
          const { homeDir } = await import("@tauri-apps/api/path");
          return await homeDir();
        } catch { return undefined; }
      })();
      const result = await open({
        multiple: false,
        directory: false,
        defaultPath: home ? `${home}/.ssh` : undefined,
        filters: [{ name: "SSH key", extensions: ["", "pem", "key", "pub", "rsa", "ed25519"] }],
      });
      if (typeof result === "string") onPath(result);
    } catch (e) {
      console.error("[ssh-picker]", e);
    }
  };

  const onBrowse = () => {
    if (isTauri) void pickViaTauri();
    else fileRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    onData(f.name, text);
    // Reset so picking the same file again still fires onChange.
    if (fileRef.current) fileRef.current.value = "";
  };

  const summary = keyData
    ? `${keyPath ?? "key"} · ${keyData.length} bytes attached`
    : keyPath ?? "No key selected";

  return (
    <div className="ssh-key-picker">
      <div className="ssh-key-summary">
        <FileKey size={13} />
        <span className={keyPath || keyData ? "" : "muted"} title={summary}>{summary}</span>
      </div>
      <div className="row-flex" style={{ gap: 4 }}>
        <button type="button" className="btn-pill" onClick={onBrowse}>Browse…</button>
        {(keyPath || keyData) && (
          <button type="button" className="btn-pill" onClick={onClear}>Clear</button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pem,.key,.pub,.rsa,.ed25519,text/*"
        style={{ display: "none" }}
        onChange={onFileChange}
        data-testid="ssh-key-input"
      />
    </div>
  );
}
