# Nembrix

[![Downloads](https://img.shields.io/github/downloads/nembrix/nembrix/total?label=downloads)](https://github.com/nembrix/nembrix/releases)
[![Latest release](https://img.shields.io/github/v/release/nembrix/nembrix?include_prereleases&label=release)](https://github.com/nembrix/nembrix/releases)

Cross-platform desktop database client built on **Tauri 2** (Rust + React).
Ships Postgres with SSH-tunnel connections, schema-aware autocomplete,
streamed result grid with cancel, SQL formatting, native role management,
schema diff, ER diagram, CSV/JSON/SQL import & export, and a command
palette.

For end-user documentation, see [`apps/docs/`](apps/docs/) — Astro
Starlight site, runnable with `yarn docs:dev`. See [Layout](#layout)
for the workspace structure.

## Features

- **Multi-session rail** — multiple live sessions per saved connection,
  drag-to-reorder, one-click recents.
- **SSH-first** — native russh tunnels (password / key / agent auth) with
  TOFU host verification.
- **Editable result grid** — double-click a cell to edit; ⌘S commits all
  pending changes in one transaction; right-click to copy / set NULL.
- **Schema-aware SQL editor** — CodeMirror with autocomplete off your live
  schema, SQL formatting, streamed results with cancel.
- **JavaScript scripting** — write JS with `await db.query(...)`, loops,
  and `console.log` over a live SQL connection ([below](#javascript-scripting)).
- **Real `EXPLAIN ANALYZE`** — heat-colored plan tree; hot branches surface
  at a glance.
- **Schema tools** — structure pane, schema diff with migration preview,
  ER diagram, role/grant matrix.
- **Copy between connections** — move a table or a whole database between
  two live connections with FK ordering handled for you.
- **Import / export** — CSV / JSON / SQL, plus a bulk multi-table export.
- **Command palette** — `⌘P` fuzzy-search across actions, connections,
  schema items, open tabs, and recent SQL.
- **Native & private** — Postgres-first, cross-platform (macOS / Windows /
  Linux), no required cloud account, no telemetry by default.

## JavaScript scripting

Toggle a **Query** tab from SQL to **JavaScript** (the `Lang` picker in
the editor toolbar) to run JS over your live connection — useful for
per-row work and quick data munging that's awkward in one statement.
Scripting is SQL-engine only (Postgres / MySQL / SQLite).

```js
// Parameters are bound positionally ($1, $2, …) — never string-interpolated.
const users = await db.query(
  "SELECT id, email FROM users WHERE id > $1",
  [0],
);

for (const u of users) {
  console.log(`user ${u.id}: ${u.email}`);   // → Message tab
}

return users;                                 // → Data grid
```

- `await db.query(sql, params?)` returns an array of row objects.
- `console.log(...)` → the **Message** tab; the returned/last query → the
  **Data** grid.
- Scripts run in a sandbox with **only** `db` and `console` (no filesystem
  or network), a **wall-clock timeout** (a runaway loop can't hang the
  app), and a **Cancel** button.

Full guide: [JavaScript scripting docs](apps/docs/src/content/docs/scripting.mdx).

## Install (pre-release)

> [!WARNING]
> **Nembrix is currently in pre-release** (versions `0.x.x`). The
> on-disk format, IPC shape, and stored-secret keys may change without
> notice between minor versions. Don't use it as the only client
> against production data.

### Download v0.4.4

Direct installer links — these download the file, no Releases page detour.
<!-- Kept current by `yarn bump-version`; see apps/desktop/scripts/bump-version.ts. -->

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_macOS_Apple_Silicon.dmg) |
| macOS (Intel) | [`.dmg`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_macOS_Intel.dmg) |
| Windows (x64) | [`.msi`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_x64_en-US.msi) · [`.exe`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_x64-setup.exe) |
| Windows (ARM64) | [`.msi`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_arm64_en-US.msi) · [`.exe`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_arm64-setup.exe) |
| Linux (Debian/Ubuntu) | [`.deb`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_amd64.deb) |
| Linux (Fedora/RHEL) | [`.rpm`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix-0.4.4-1.x86_64.rpm) |
| Linux (universal) | [`.AppImage`](https://github.com/nembrix/nembrix/releases/download/v0.4.4/Nembrix_0.4.4_amd64.AppImage) |

Every other build, plus checksums and signatures, is on the
[Releases](https://github.com/nembrix/nembrix/releases) page.

### macOS

```sh
brew tap nembrix/nembrix
brew install --cask nembrix
```

Or grab the `.dmg` from the table above — **Apple Silicon** or **Intel**.

Builds are signed and **notarized**, so they open with a normal
double-click. (If you grabbed an older, pre-notarization build,
Gatekeeper may block it — right-click the app → **Open** once to clear
the warning.)

### Windows

Download the `.msi` installer or portable `.exe` from the table above.

The installer is not yet **Authenticode-signed**, so Windows
SmartScreen will show a "Microsoft Defender SmartScreen prevented an
unrecognized app from starting" warning. Click **More info** → **Run
anyway**.

### Linux

```sh
# AppImage — universal
chmod +x Nembrix_*_amd64.AppImage
./Nembrix_*_amd64.AppImage

# Debian / Ubuntu
sudo apt install ./Nembrix_*_amd64.deb
```

Nightly ships `x86_64` Linux builds; tagged releases additionally
include an `arm64` AppImage. See the
[Releases](https://github.com/nembrix/nembrix/releases) page.

### From source

If you'd rather build locally — see [Dev loop](#dev-loop) below.
Maintainers cutting a release: see [`RELEASING.md`](RELEASING.md).

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the three runtime backends (Tauri, Node sidecar, mock), how sessions sit on top of connections, and how the session resolver keeps the UI from caring about pool handles.

## Layout

```
nembrix/                      # yarn workspace monorepo
  apps/
    desktop/                  # the Tauri app
      Cargo.toml              #   Rust workspace
      src-tauri/              #   Tauri shell (commands, AppState, IPC)
      crates/
        db-core/              #     driver-agnostic trait + types
        db-postgres/          #     sqlx-based Postgres driver
        ssh-tunnel/           #     russh local-port-forwarding tunnel
        secrets/              #     keyring + SQLite metadata store
        sql-format/           #     sqlformat-rs wrapper
      src/                    #   React + Vite frontend
        components/  features/  editor/  ipc/  store/
      bindings/               #   specta-generated TS bindings
    docs/                     # Astro Starlight end-user docs
  brand/                      # logo / icon / wordmark source assets
  docker/                     # Postgres + sshd verification fixture
```

## Prerequisites

- **Rust** ≥ 1.77 — install via
  `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node** ≥ 22
- **Yarn** (this repo enforces yarn; `npm install` is blocked)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- `tauri-cli`: `cargo install tauri-cli --version "^2.0"`

## Dev loop

Three modes, ordered from heaviest to lightest:

```bash
yarn install

# 1. Full Tauri app — Rust backend, SSH tunnels, OS keychain.
#    Requires Rust + tauri-cli. Use for shipping work and SSH testing.
yarn tauri dev

# 2. Browser + Node sidecar — real Postgres via node-postgres, no Rust needed.
#    Vite serves the UI, the sidecar (scripts/dev-sidecar.ts) opens TCP
#    connections to Postgres. SSH tunnels are NOT supported here.
yarn dev:all

# 3. Browser only — mock backend (canned schema + 3 rows).
#    Fast UI iteration without any database. The Mock mode banner makes
#    this state obvious.
yarn dev
```

The frontend probes `localhost:1421/healthz` at boot. If the sidecar is up,
every DB-touching command (connect, introspect, execute, stream, cancel)
routes through HTTP to real Postgres. If not, the in-memory mock answers.
A coloured banner at the top of the inspector tells you which is active.

## Verification (v1)

```bash
cd docker && docker compose up -d
# In the app: new connection
#   host=db port=5432 user=app password=app database=demo
#   SSH tunnel: host=localhost port=2222 user=demo password=demo
#   (strict_host_key=false on first run; the TOFU dialog adds the host)
```

The DB is on an internal-only Docker network — direct connection fails, only the
tunnelled connection works. From there:

1. Connect → schema tree appears in the sidebar.
2. Double-click `users` → opens a query tab pre-filled with `SELECT * FROM public.users LIMIT 200;`
3. Run → results stream into the grid.
4. Cmd+Shift+F → SQL is reformatted.
5. Run `SELECT pg_sleep(30)` then press Cancel — query is aborted via
   `pg_cancel_backend` on the sidechannel pool.

## Command palette

`⌘P` (or `⇧⌘P`) opens a fuzzy-search palette across **everything**: menu
actions, saved connections, schema items (tables / views / functions) of
the active connection, open tabs, and recent SQL.

- `↑` / `↓` move · `↵` run · `esc` close
- `Tab` cycles modes when the input is empty
- Mode prefixes filter to one category:
  - `>` actions
  - `@` schema items
  - `:` open tabs
  - `#` recent SQL

Recently-chosen entries are pinned to the top of the list when the query
is empty.

## Result-grid workbench

The result grid does more than display rows:

- **Click any column header** → a popover with `distinct / null% / min / max /
  top-10` values, computed from rows in memory. Click a top-value row to add
  it as a filter chip.
- **Foreign-key columns** are highlighted with an `fk` badge. Clicking a FK
  cell opens a side panel with the referenced row, plus an "Open in tab"
  shortcut.
- **Filter chips** at the top of the result panel compile to a `WHERE` clause
  that's injected into the editor (idempotently — toggling chips off restores
  the original SQL). Re-runs automatically.
- **Chart tab** — pick X / Y / aggregate and the current result set renders
  as an SVG bar chart, no extra library.
- **Pin a row** via the gutter button to keep it sticky while you scroll
  long result sets.

These rely on schema introspection finding the source relation, so they
only light up for tabs opened from a sidebar table / palette item / FK
navigation. Hand-written joined queries still get the column-summary
popover and pinning.

## Tests

### Frontend unit (Vitest)

```bash
yarn test:unit          # one shot
yarn test:unit:watch    # watch mode
```

Covers the fuzzy matcher and other pure frontend logic. Runs in milliseconds.

### Frontend E2E (Playwright)

```bash
yarn test:e2e:install   # one-time: install chromium
yarn test:e2e           # headless
yarn test:e2e:ui        # interactive runner
```

Playwright drives the Vite dev server against the in-browser mock IPC layer
in `src/ipc/commands.ts`. No Rust host or Docker required.

### Rust unit + integration tests (testcontainers)

```bash
cargo test                           # all crates
cargo test -p db-postgres            # spins postgres:16-alpine via testcontainers
cargo test -p ssh-tunnel             # spins linuxserver/openssh-server + echo server
```

Integration tests are skipped automatically when Docker isn't running.
Set `DBCLIENT_REQUIRE_DOCKER=1` in CI to fail loudly instead of skipping.
Set `DBCLIENT_SKIP_DOCKER=1` to force-skip on machines with Docker installed.

## Roadmap

- **v1** (this milestone) — Postgres + SSH + editor + grid + cancel.
- **v2** — Roles/grants UI, Activity tab (sessions / locks / server stats),
  query history, saved queries, multi-tab persistence.
- **v3** — Schema diff, ER diagram (react-flow), CSV/JSON/SQL import + export.
- **v4** — MySQL + SQLite drivers behind the same `DbConnection` trait.
- **v5** — MongoDB + Redis with `@codemirror/lang-javascript` editor + sampled-doc autocomplete.
