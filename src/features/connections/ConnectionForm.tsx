import { useEffect, useRef, useState } from "react";
import { Database, FileKey, X } from "lucide-react";
import * as api from "@/ipc/commands";
import { isTauri } from "@/ipc/commands";
import type { ConnectionInput, ConnectionRecord, Environment } from "@/ipc/types";
import { useStore } from "@/store";
import { ENV_COLOR, ENV_LABEL, ENVIRONMENTS, colorFor } from "./environment";

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
    engine: "postgres",
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
  const [testMsg, setTestMsg] = useState<string | null>(null);
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

  const onTest = async () => {
    setWorking("test");
    setTestMsg("Testing…");
    try {
      const ms = await api.testConnection(finalInput());
      setTestMsg(`OK · ${ms} ms`);
    } catch (e) {
      setTestMsg(`Failed: ${e}`);
    } finally {
      setWorking(null);
    }
  };

  const onSave = async () => {
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
          <span>{editing ? `Edit ${editing.name}` : "New PostgreSQL connection"}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="section-title">General</div>
            <label htmlFor="cf-name">Name</label>
            <input id="cf-name" type="text" value={v.name} onChange={(e) => patch({ name: e.target.value })} />
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
            className="btn-pill"
            onClick={onTest}
            disabled={!!working}
          >
            {working === "test" ? "Testing…" : "Test"}
          </button>
          {testMsg && <span className="muted">{testMsg}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose} disabled={!!working}>Cancel</button>
          <button
            className="btn-pill"
            onClick={onSave}
            disabled={!!working}
          >
            {working === "save"
              ? (editing ? "Updating…" : "Saving…")
              : (editing ? "Update" : "Save")}
          </button>
          <button
            className="btn-pill primary"
            onClick={onSaveAndConnect}
            disabled={!!working}
            title={editing
              ? "Update this connection and connect to it"
              : "Save this connection and connect to it now"}
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
