import { useEffect, useState } from "react";
import ConnectionRail from "@/components/ConnectionRail";
import Inspector from "@/components/Inspector";
import TabBar from "@/components/TabBar";
import MenuBar from "@/components/MenuBar";
import BackendBanner from "@/components/BackendBanner";
import StatusBar from "@/components/StatusBar";
import EmptyTabArea from "@/components/EmptyTabArea";
import ShortcutsModal from "@/components/ShortcutsModal";
import PreferencesDialog from "@/features/preferences/PreferencesDialog";
import AboutDialog from "@/components/AboutDialog";
import UpdateDialog from "@/features/updater/UpdateDialog";
import CommandPalette from "@/components/CommandPalette";
import QueryTab from "@/features/query/QueryTab";
import TableDataTab from "@/features/table_data/TableDataTab";
import ActivityTab from "@/features/activity/ActivityTab";
import RolesTab from "@/features/roles/RolesTab";
import ErDiagramTab from "@/features/er/ErDiagramTab";
import SchemaDiffTab from "@/features/diff/SchemaDiffTab";
import ConnectionForm from "@/features/connections/ConnectionForm";
import ConnectionManagerDialog from "@/features/connections/ConnectionManagerDialog";
import CopyDialog from "@/features/copy/CopyDialog";
import ObjectOpDialog from "@/features/object_ops/ObjectOpDialog";
import BulkExportDialog from "@/features/export/BulkExportDialog";
import ImportDialog from "@/features/import/ImportDialog";
import { useStore } from "@/store";
import { startMenuBridge } from "@/menu/dispatch";
import { installAccelerators } from "@/menu/accelerators";
import { registerAllMenuHandlers } from "@/menu/handlers";
import { startMenuStateSync } from "@/menu/sync";
import { startTabsPersistence } from "@/store/persist";
import { isTauri, registerSessionResolver } from "@/ipc/commands";

export default function App() {
  const {
    tabs, activeTabId, selectedConnId,
    connectionFormOpen, openConnectionForm, closeConnectionForm,
    bulkExportOpen, bulkExportSchema, closeBulkExport,
    importOpen, importSchema, closeImport,
    connectionManagerOpen, closeConnectionManager,
    copyOpen, copyMode, copySource, closeCopy,
    preferencesOpen, closePreferences,
    panels,
  } = useStore();
  // The active tab must belong to the selected session — otherwise switching
  // connections would render the previous session's tab in the main pane.
  const active = tabs.find(
    (t) => t.id === activeTabId && t.connId === selectedConnId,
  );

  // Register handlers + bridges once.
  useEffect(() => {
    // Sessions live on top of connections — the api layer needs to
    // translate session ids back to connection ids before going over
    // the wire. We register here once so commands.ts stays free of any
    // store dependency.
    registerSessionResolver((id) => {
      const sess = useStore.getState().sessions.find((s) => s.id === id);
      return sess?.connectionId ?? id;
    });
    // Tab/session state is now hydrated in main.tsx BEFORE first render (so the
    // initial paint shows the restored tabs, not a flash of the empty state).
    registerAllMenuHandlers();
    void startMenuBridge();
    installAccelerators();
    startMenuStateSync();
    startTabsPersistence();
  }, []);

  // "Install on Quit": if an update was downloaded and deferred, apply it as
  // the window closes. We intercept the close, run the install, then close
  // for real — Tauri's updater applies packages from the frontend, so this
  // is the last moment we can reach it.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let closing = false;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (e) => {
        // Our own re-close must fall through, or we'd loop forever.
        if (closing) return;
        const { getPendingInstall, runPendingInstall } = await import(
          "@/features/updater/pendingInstall"
        );
        if (!getPendingInstall()) return;
        e.preventDefault();
        closing = true;
        // Best-effort: runPendingInstall swallows failures so a broken
        // install can never trap the user in an app they're closing.
        await runPendingInstall();
        await win.destroy();
      });
    })();
    return () => unlisten?.();
  }, []);

  // Inspector width is user-resizable via the drag handle on its
  // right edge. Persisted to localStorage so the layout survives
  // reloads. Clamped 200..600 — narrower and the column tree wraps
  // unreadably; wider and the main canvas gets squeezed.
  const [inspectorW, setInspectorW] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("nembrix.inspector.w") ?? "");
      if (Number.isFinite(v) && v >= 200 && v <= 600) return v;
    } catch { /* localStorage off; fall through to default */ }
    return 268;
  });
  useEffect(() => {
    try { localStorage.setItem("nembrix.inspector.w", String(inspectorW)); } catch { /* ignore: best-effort */ }
  }, [inspectorW]);

  const onInspectorResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorW;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(200, Math.min(600, startW + (ev.clientX - startX)));
      setInspectorW(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Grid template adapts when rail/inspector are hidden. We *omit* the
  // hidden track entirely (rather than collapse it to 0) and conditionally
  // render the child — that way the grid stays in lockstep with what's
  // actually on screen and the main column never lands in the wrong track.
  const cols: string[] = [];
  if (panels.rail) cols.push("var(--rail-w)");
  if (panels.inspector) cols.push(`${inspectorW}px`);
  cols.push("1fr");
  const gridTemplate = cols.join(" ");

  return (
    <div className={`app ${isTauri ? "is-tauri" : ""}`} style={{ gridTemplateColumns: gridTemplate }}>
      {panels.rail && <ConnectionRail onNewConnection={openConnectionForm} />}
      {panels.inspector && (
        <div className="inspector-wrap">
          <Inspector />
          {/* Drag handle on the right edge — 4px wide, transparent
              until hovered. Click-drag to resize, double-click to
              snap back to the 268px default. */}
          <div
            className="inspector-resize"
            onMouseDown={onInspectorResizeStart}
            onDoubleClick={() => setInspectorW(268)}
            title="Drag to resize · double-click to reset"
            role="separator"
            aria-orientation="vertical"
          />
        </div>
      )}
      <main className="main">
        <MenuBar />
        <BackendBanner />
        <StatusBar />
        <TabBar />
        {active ? (
          active.kind === "query"      ? <QueryTab tab={active} /> :
          active.kind === "table_data" ? <TableDataTab tab={active} /> :
          active.kind === "activity"   ? <ActivityTab tab={active} /> :
          active.kind === "roles"      ? <RolesTab tab={active} /> :
          active.kind === "er_diagram" ? <ErDiagramTab tab={active} /> :
          active.kind === "schema_diff" ? <SchemaDiffTab tab={active} /> :
          null
        ) : (
          <EmptyTabArea />
        )}
      </main>
      {connectionFormOpen && <ConnectionForm onClose={closeConnectionForm} />}
      {connectionManagerOpen && <ConnectionManagerDialog onClose={closeConnectionManager} />}
      {copyOpen && <CopyDialog mode={copyMode} source={copySource} onClose={closeCopy} />}
      {bulkExportOpen && selectedConnId && (
        <BulkExportDialog
          connId={selectedConnId}
          preselectSchema={bulkExportSchema ?? undefined}
          onClose={closeBulkExport}
        />
      )}
      {importOpen && selectedConnId && (
        <ImportDialog
          connId={selectedConnId}
          schema={importSchema ?? undefined}
          onClose={closeImport}
        />
      )}
      <ObjectOpDialog />
      <ShortcutsModal />
      {preferencesOpen && <PreferencesDialog onClose={closePreferences} />}
      <AboutDialog />
      <UpdateDialog />
      <CommandPalette />
    </div>
  );
}
