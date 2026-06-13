# Architecture

Nembrix runs the same React UI on top of three different backends. Which one is active is decided at build time.

## Runtime modes

### Tauri (native)

The shipped desktop build. The UI runs in a Tauri webview; every database call goes through Tauri commands implemented in Rust. Connection pools live in Rust (`sqlx` / `tokio-postgres`) so the UI doesn't pay JS-side serialization for each query.

### Node sidecar

The browser dev mode. The React UI runs on Vite at the usual port; a Node "sidecar" process exposes the same command API over HTTP at `localhost:1421`. Same surface, same shape of response, easier inspection in DevTools.

### Mock

Browser, no sidecar. Every command is answered by a fixture layer. Useful for UI work, docs screenshots, and tests where starting a real Postgres is overkill.

## Sessions on top of connections

A **connection** is what you configure in the connection manager: host, port, db, credentials. A **session** is a runtime instance of a connection. You can open the same connection in two sessions side-by-side — each gets its own pool slot, its own transaction state, its own tab list.

This is what powers the sidebar's session rail: opening the same saved connection twice produces two distinct sessions, not a shared one.

## Schema cache

The schema cache is keyed by **session id**, not connection id. Two sessions against the same connection introspect independently and don't invalidate each other. ⌘R invalidates only the focused session's cache.

## The session resolver

UI code in `commands.ts` always speaks in session ids. The session resolver translates the session id back to a connection id (and a pool handle, for Tauri) at the wire layer just before the call leaves. The rest of the app never has to think about connection ids.

The same resolver indirection is what lets the mock backend swap in cleanly: it answers commands keyed by session id without caring about connections at all.
