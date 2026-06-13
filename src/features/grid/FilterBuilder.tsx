import { useEffect, useMemo, useRef, useState } from "react";
import { Filter, Plus, X } from "lucide-react";
import type { ColMeta } from "@/ipc/types";
import type { FilterChip } from "@/store";
import { validateFilterValue } from "./filter_validate";

interface Props {
  /** Available columns from the active result set. */
  columns: ColMeta[];
  /** The currently-applied chips. We render these as editable rows. */
  filters: FilterChip[];
  /** Commit the whole list at once. The dialog manages a draft list
   *  internally so half-typed values don't fire a query per keystroke. */
  onApply: (filters: FilterChip[]) => void;
}

/** All operators we support, grouped for the picker. `IS NULL` /
 *  `IS NOT NULL` skip the value entirely (the input is disabled).
 *  CONTAINS / ICONTAINS compile to LIKE / ILIKE with `%v%` server-side. */
const OPS: { op: FilterChip["op"]; label: string }[] = [
  { op: "=",                 label: "=" },
  { op: "!=",                label: "≠" },
  { op: "<",                 label: "<" },
  { op: "<=",                label: "≤" },
  { op: ">",                 label: ">" },
  { op: ">=",                label: "≥" },
  { op: "CONTAINS",          label: "contains" },
  { op: "NOT CONTAINS",      label: "does not contain" },
  { op: "ICONTAINS",         label: "contains (case-insensitive)" },
  { op: "NOT ICONTAINS",     label: "does not contain (case-insens.)" },
  { op: "LIKE",              label: "LIKE (raw pattern)" },
  { op: "ILIKE",             label: "ILIKE (raw, case-insens.)" },
  { op: "IS NULL",           label: "is null" },
  { op: "IS NOT NULL",       label: "is not null" },
];

/** Ops that don't take a value — the input is hidden / disabled. */
const NULL_OPS: ReadonlySet<FilterChip["op"]> = new Set(["IS NULL", "IS NOT NULL"]);

/** "Empty" filter row used when the user clicks + Add filter. */
function makeEmpty(columnName: string): FilterChip {
  return {
    id: crypto.randomUUID(),
    column: columnName,
    op: "=",
    value: "",
  };
}

/**
 * TablePlus-style inline filter builder.
 *
 * Each row exposes column / op / value with live validation. Rows
 * AND together. We hold an internal `draft` list so typing doesn't
 * spam re-queries — Apply (or Enter on a value field) commits.
 *
 * Better than TablePlus:
 *  - No separate Apply per row; one Apply commits the whole set.
 *  - Validation is inline and per-column-type (numeric, uuid, date,
 *    json, bool) instead of opaque server errors.
 *  - Compact "chips" mode: collapse to one-line read-only chips when
 *    nothing is being edited, expand on click.
 */
export default function FilterBuilder({ columns, filters, onApply }: Props) {
  const [draft, setDraft] = useState<FilterChip[]>(filters);
  const [expanded, setExpanded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Re-sync the draft when external filters change (e.g. cleared via
  // a different control, or seeded from the column-summary popover).
  useEffect(() => { setDraft(filters); }, [filters]);

  // Map column name → its ColMeta for validator lookup.
  const colByName = useMemo(
    () => new Map(columns.map((c) => [c.name, c])),
    [columns],
  );

  /** Re-validate every row; returns true when all are valid. */
  const validateAll = (rows: FilterChip[]): boolean => {
    const next: Record<string, string> = {};
    for (const f of rows) {
      const col = colByName.get(f.column);
      const typeName = col?.type_name ?? "text";
      const msg = validateFilterValue(typeName, f.op, f.value ?? "");
      if (msg) next[f.id] = msg;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const update = (id: string, patch: Partial<FilterChip>) => {
    setDraft((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };
  const remove = (id: string) => {
    setDraft((cur) => cur.filter((f) => f.id !== id));
    setErrors((cur) => {
      const { [id]: _, ...rest } = cur;
      return rest;
    });
  };
  const add = () => {
    const first = columns[0]?.name ?? "";
    setDraft((cur) => [...cur, makeEmpty(first)]);
    setExpanded(true);
  };
  /** Returns true when this chip is ready to commit (validated + has value). */
  const isReady = (f: FilterChip): boolean => {
    if (NULL_OPS.has(f.op)) return true;
    if ((f.value ?? "").trim().length === 0) return false;
    const col = colByName.get(f.column);
    const typeName = col?.type_name ?? "text";
    return validateFilterValue(typeName, f.op, f.value ?? "") === null;
  };

  /** Apply ALL rows: enable the ready ones, keep disabled-by-user rows
   *  disabled, drop totally-empty rows entirely. Does NOT clear when the
   *  user has chips with empty values — those just stay disabled. */
  const applyAll = () => {
    if (!validateAll(draft.filter(isReady))) return;
    const next = draft
      .filter((f) => isReady(f) || (f.value ?? "").length > 0)
      .map((f) => ({ ...f, enabled: isReady(f) ? (f.enabled !== false) : false }));
    setDraft(next);
    onApply(next);
    setExpanded(false);
  };

  /** Apply ONE row — toggle it on (if ready), leave the others alone. */
  const applyOne = (id: string) => {
    const target = draft.find((f) => f.id === id);
    if (!target) return;
    if (!isReady(target)) {
      // Re-validate so the user sees the error inline.
      setErrors((cur) => ({ ...cur, [id]: "value required" }));
      return;
    }
    const next = draft.map((f) => f.id === id ? { ...f, enabled: true } : f);
    setDraft(next);
    onApply(next);
  };

  const toggleEnabled = (id: string) => {
    const next = draft.map((f) => f.id === id ? { ...f, enabled: f.enabled === false } : f);
    setDraft(next);
    onApply(next);
  };

  const discardAll = () => {
    setDraft([]);
    setErrors({});
    onApply([]);
    setExpanded(false);
  };

  // "Add filter" only meaningful once columns are known — otherwise the
  // column picker would be empty and validators would have nothing to
  // key on. Defer until the table loads.
  const canEdit = columns.length > 0;

  // Collapsed strip: read-only chips + "+ Add filter" button.
  if (!expanded) {
    const hasAny = filters.length > 0;
    return (
      <div className="filter-builder collapsed">
        <Filter size={12} className="muted" />
        {hasAny ? (
          <>
            <div className="chips">
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="chip editable"
                  onClick={() => canEdit && setExpanded(true)}
                  disabled={!canEdit}
                  title={canEdit ? "Click to edit" : "Wait for the table to load"}
                >
                  <span className="col">{f.column}</span>
                  <span className="op">{OPS.find((x) => x.op === f.op)?.label ?? f.op}</span>
                  {f.value != null && !NULL_OPS.has(f.op) && (
                    <span className="val">{truncate(f.value, 24)}</span>
                  )}
                </button>
              ))}
            </div>
            <button className="btn-pill" onClick={() => setExpanded(true)} disabled={!canEdit}>
              Edit
            </button>
            <button className="btn-pill" onClick={discardAll}>Clear all</button>
          </>
        ) : (
          <button
            className="btn-pill"
            onClick={add}
            disabled={!canEdit}
            title={canEdit ? undefined : "Wait for the table to load before adding filters"}
          >
            <Plus size={11} /> Add filter
          </button>
        )}
      </div>
    );
  }

  // Expanded: one row per filter, editable.
  return (
    <div className="filter-builder expanded">
      {draft.length === 0 && (
        <div className="muted" style={{ padding: "6px 0", fontSize: 12 }}>
          No filters yet. Click <strong>+ Add filter</strong> to start.
        </div>
      )}
      {draft.map((f) => {
        const col = colByName.get(f.column);
        const typeName = col?.type_name ?? "text";
        const err = errors[f.id];
        const needsValue = !NULL_OPS.has(f.op);
        const isEnabled = f.enabled !== false;
        return (
          <div
            key={f.id}
            className={`filter-row ${err ? "has-error" : ""} ${isEnabled ? "" : "row-disabled"}`}
          >
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={() => toggleEnabled(f.id)}
              title={isEnabled ? "Disable this filter" : "Enable this filter"}
              className="filter-enabled"
            />
            <select
              value={f.column}
              onChange={(e) => update(f.id, { column: e.target.value })}
              className="filter-col"
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <select
              value={f.op}
              onChange={(e) => {
                const op = e.target.value as FilterChip["op"];
                update(f.id, { op, ...(NULL_OPS.has(op) ? { value: "" } : {}) });
              }}
              className="filter-op"
            >
              {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            <input
              type="text"
              value={needsValue ? (f.value ?? "") : ""}
              placeholder={needsValue ? typeName : "— no value —"}
              title={!needsValue
                ? "This operator doesn't take a value"
                : (err ?? `${typeName} value`)}
              onChange={(e) => update(f.id, { value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyOne(f.id);
                if (e.key === "Escape") setExpanded(false);
              }}
              disabled={!needsValue}
              className={`filter-val ${err ? "invalid" : ""} ${!needsValue ? "disabled" : ""}`}
            />
            <span className="filter-type-hint muted" title={`Column type: ${typeName}`}>{typeName}</span>
            <button
              className="btn-pill"
              onClick={() => applyOne(f.id)}
              title="Apply just this filter"
            >
              Apply
            </button>
            <button
              className="icon-btn"
              onClick={() => remove(f.id)}
              title="Remove this filter"
              aria-label="Remove filter"
            >
              <X size={12} />
            </button>
            {err && (
              <div className="filter-row-err">
                {err}
              </div>
            )}
          </div>
        );
      })}
      <div className="filter-actions">
        <button className="btn-pill" onClick={add}>
          <Plus size={11} /> Add filter
        </button>
        <button className="btn-link" onClick={discardAll} title="Remove every filter">
          Clear all
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn-link" onClick={() => { setDraft(filters); setExpanded(false); }}>
          Close
        </button>
        <button
          className="btn-pill primary"
          onClick={applyAll}
          disabled={Object.keys(errors).length > 0}
          title="Apply every ready filter row"
        >
          Apply all
        </button>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
