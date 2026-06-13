/**
 * App-wide preferences. localStorage-backed, no schema migration today —
 * unknown fields are dropped on parse so adding new ones never breaks
 * existing users.
 *
 * Keep this struct tiny — anything that's only relevant to one feature
 * belongs in its own module (e.g. groups, recents, inspector_prefs).
 */

const KEY = "nembrix.prefs.v1";

export interface Prefs {
  csv: {
    /** Token that represents NULL in unquoted cells. "NULL" by default. */
    nullToken: string;
    /** Default delimiter for new export / import dialogs. */
    delimiter: string;
    /** When true, a totally empty unquoted cell is parsed as NULL too;
     *  when false (the default), empty stays as the empty string so the
     *  empty-vs-null distinction round-trips through CSV. */
    emptyIsNull: boolean;
    /** \n or \r\n. */
    lineEnding: "\n" | "\r\n";
  };
}

export const DEFAULT_PREFS: Prefs = {
  csv: {
    nullToken: "NULL",
    delimiter: ",",
    emptyIsNull: false,
    lineEnding: "\n",
  },
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_PREFS);
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      csv: { ...DEFAULT_PREFS.csv, ...(parsed.csv ?? {}) },
    };
  } catch {
    return clone(DEFAULT_PREFS);
  }
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
