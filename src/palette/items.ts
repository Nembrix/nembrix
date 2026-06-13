/**
 * Candidate set for the command palette.
 *
 * Five categories:
 *   - action       — every menu entry that has an id
 *   - connection   — saved connections (jump = select + connect)
 *   - item         — schema items in the active connection (tables/views/funcs)
 *   - tab          — open tabs (jump to it)
 *   - history      — recent queries from query history
 *
 * Categories are merged before fuzzy filtering; the result list groups them
 * back at render time. Each item carries `subtitle` (right-aligned dim text)
 * and `accel` (kbd hint) — both optional.
 */

import { MENUS, MENU, type MenuId } from "@/menu/ids";
import { dispatchMenu } from "@/menu/dispatch";
import { isEnabled } from "@/menu/availability";
import { useStore } from "@/store";

export type ItemKind = "action" | "connection" | "item" | "tab" | "history";

export interface PaletteItem {
  id: string;             // unique within the palette
  kind: ItemKind;
  title: string;          // primary text — what we fuzzy-match against
  subtitle?: string;      // secondary (right-aligned)
  group: string;          // group heading
  accel?: string;
  run: () => void | Promise<void>;
  /** Optional secondary search text (extends what fuzzy matches against). */
  searchExtra?: string;
  /** False when the action is not currently applicable. Hidden from the
   *  default list; shown dimmed only when the user explicitly types its name. */
  enabled?: boolean;
}

export function buildPaletteItems(): PaletteItem[] {
  const s = useStore.getState();
  const out: PaletteItem[] = [];

  /* ── menu actions ── */
  for (const group of MENUS) {
    for (const it of group.items) {
      if (it.separator || !it.id || !it.label) continue;
      const enabled = isEnabled(it.id as MenuId, s);
      out.push({
        id: `action:${it.id}`,
        kind: "action",
        title: it.label,
        subtitle: group.label,
        group: group.label,
        accel: it.accel,
        enabled,
        // Disabled actions still dispatch (with force) when the user goes
        // out of their way to pick them — surfaces a console warning so they
        // know why it didn't take effect.
        run: () => dispatchMenu(it.id!, { force: !enabled }),
      });
    }
  }

  /* ── connections ── */
  for (const c of s.connections) {
    out.push({
      id: `conn:${c.id}`,
      kind: "connection",
      title: c.name,
      subtitle: `${c.username}@${c.host}:${c.port}${c.database ? "/" + c.database : ""}`,
      group: "Connections",
      run: async () => {
        useStore.getState().selectConn(c.id);
        await dispatchMenu(MENU.CONNECT);
      },
      searchExtra: `${c.host} ${c.username} ${c.database ?? ""}`,
    });
  }

  /* ── schema items in the active connection ── */
  const connId = s.selectedConnId;
  const tree = connId ? s.schemas[connId] : undefined;
  if (connId && tree) {
    for (const db of tree.databases) {
      for (const sc of db.schemas) {
        for (const t of sc.tables) {
          const fq = `${sc.name}.${t.name}`;
          out.push({
            id: `tbl:${connId}:${fq}`,
            kind: "item",
            title: t.name,
            subtitle: `Table · ${sc.name}`,
            group: "Tables",
            run: () => useStore.getState().addTab({
              id: crypto.randomUUID(),
              connId, kind: "table_data",
              title: t.name,
              sourceRelation: { schema: sc.name, table: t.name },
              limit: 200,
            }),
            searchExtra: fq,
          });
        }
        for (const v of sc.views) {
          out.push({
            id: `view:${connId}:${sc.name}.${v.name}`,
            kind: "item",
            title: v.name,
            subtitle: `View · ${sc.name}`,
            group: "Views",
            run: () => useStore.getState().addTab({
              id: crypto.randomUUID(),
              connId, kind: "table_data",
              title: v.name,
              sourceRelation: { schema: sc.name, table: v.name },
              limit: 200,
            }),
            searchExtra: `${sc.name}.${v.name}`,
          });
        }
        for (const fn of sc.functions) {
          out.push({
            id: `fn:${connId}:${sc.name}.${fn.name}`,
            kind: "item",
            title: fn.name,
            subtitle: `Function · ${sc.name} → ${fn.return_type}`,
            group: "Functions",
            run: () => useStore.getState().addTab({
              id: crypto.randomUUID(),
              connId, kind: "query",
              title: fn.name,
              sql: `SELECT * FROM ${sc.name}.${fn.name}(${fn.argument_types.map((_, i) => `$${i + 1}`).join(", ")});`,
            }),
          });
        }
      }
    }
  }

  /* ── open tabs ── */
  for (const t of s.tabs) {
    out.push({
      id: `tab:${t.id}`,
      kind: "tab",
      title: t.title || "Query",
      subtitle: t.running ? "running…" : (t.elapsedMs != null ? `${t.elapsedMs} ms` : ""),
      group: "Open tabs",
      run: () => useStore.getState().setActiveTab(t.id),
    });
  }

  /* ── recent queries (palette history) ── */
  const recent = loadRecentSql(connId);
  for (const r of recent) {
    out.push({
      id: `hist:${r.id}`,
      kind: "history",
      title: r.sql.replace(/\s+/g, " ").slice(0, 90),
      subtitle: "Recent",
      group: "Recent",
      run: () => {
        const id = useStore.getState().selectedConnId;
        if (!id) return;
        useStore.getState().addTab({
          id: crypto.randomUUID(), connId: id, kind: "query",
          title: "Recent", sql: r.sql,
        });
      },
    });
  }

  return out;
}

/* ── recently-used ranking ── */

const RECENT_PALETTE_KEY = "nembrix.palette.recent";
const RECENT_SQL_KEY = "nembrix.palette.recentSql";

interface RecentRow { id: string; sql: string }

export function loadRecentIds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_PALETTE_KEY) || "[]"); }
  catch { return []; }
}
export function rememberRecent(id: string) {
  const cur = loadRecentIds().filter((x) => x !== id);
  cur.unshift(id);
  localStorage.setItem(RECENT_PALETTE_KEY, JSON.stringify(cur.slice(0, 20)));
}

function loadRecentSql(_connId: string | null): RecentRow[] {
  try { return JSON.parse(localStorage.getItem(RECENT_SQL_KEY) || "[]"); }
  catch { return []; }
}
export function rememberRecentSql(sql: string) {
  const cur = loadRecentSql(null);
  // Skip empty / duplicate-of-most-recent
  if (!sql.trim() || (cur[0] && cur[0].sql === sql)) return;
  cur.unshift({ id: crypto.randomUUID(), sql });
  localStorage.setItem(RECENT_SQL_KEY, JSON.stringify(cur.slice(0, 10)));
}
