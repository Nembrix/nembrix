/**
 * Connection group + ordering persistence.
 *
 * Groups are not first-class entities — they're just the `group` string
 * on each ConnectionRecord. That means an *empty* group can't exist in
 * the DB. We track empty groups (groups the user created but haven't put
 * a connection in yet) here in localStorage, and we also persist the
 * per-connection ordering since the saved-connection list comes back in
 * insertion order, not user-chosen order.
 *
 * Single localStorage key keeps this trivial — the payload is small
 * even for hundreds of connections.
 */

const KEY = "nembrix.groups.v1";

export interface GroupsState {
  /** Group names the user has created but may not have any connection in
   *  yet. Connections with a `group` field implicitly create one too;
   *  this list is the union. */
  empty: string[];
  /** Connection id → numeric sort-order. Lower comes first. Missing
   *  entries sort to the end. */
  order: Record<string, number>;
}

const DEFAULT: GroupsState = { empty: [], order: {} };

export function load(): GroupsState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw);
    return {
      empty: Array.isArray(parsed.empty) ? parsed.empty : [],
      order: parsed.order && typeof parsed.order === "object" ? parsed.order : {},
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function save(state: GroupsState): void {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore: best-effort */ }
}

export function addEmptyGroup(name: string): GroupsState {
  const cur = load();
  if (!cur.empty.includes(name)) {
    cur.empty.push(name);
    save(cur);
  }
  return cur;
}

export function removeEmptyGroup(name: string): GroupsState {
  const cur = load();
  cur.empty = cur.empty.filter((g) => g !== name);
  save(cur);
  return cur;
}

/**
 * Move `connId` into a target position. We compute a new sort-order so
 * the connection ends up just above `beforeId` (or at the end of the
 * group if `beforeId` is null). The sort-order is dense — we keep
 * rewriting the whole bucket because the alternative (sparse keys)
 * adds complexity for no real win at this scale.
 */
export function reorder(
  connId: string,
  group: string,
  beforeId: string | null,
  /** All connection ids currently in the target group, in DISPLAY order
   *  (i.e. the order on screen before the move). The caller knows this
   *  because the list is already sorted in the dialog. */
  groupOrder: string[],
): GroupsState {
  const cur = load();
  // Self-target is a no-op — preserve whatever order already exists so
  // the visible row doesn't jump.
  if (beforeId === connId) {
    groupOrder.forEach((id, i) => { cur.order[id] = i; });
    save(cur);
    return cur;
  }
  // Remove the moved id from wherever it was.
  const rest = groupOrder.filter((id) => id !== connId);
  // Insert at the right spot.
  let insertAt = rest.length;
  if (beforeId) {
    const idx = rest.indexOf(beforeId);
    if (idx >= 0) insertAt = idx;
  }
  rest.splice(insertAt, 0, connId);
  // Reassign dense order indices for the whole bucket so the move is stable.
  rest.forEach((id, i) => { cur.order[id] = i; });
  save(cur);
  return cur;
}

/** Comparator factory: connections with explicit order come first by
 *  that number, the rest fall back to alphabetical by name. */
export function compareOrder(
  order: Record<string, number>,
  byName: (id: string) => string,
): (a: string, b: string) => number {
  return (a, b) => {
    const oa = order[a];
    const ob = order[b];
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return byName(a).localeCompare(byName(b));
  };
}
