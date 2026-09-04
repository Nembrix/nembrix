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
  updates: {
    /** When true, an update found by the on-launch check downloads and
     *  stages itself without prompting; the user is only told once it's
     *  ready to apply. Off by default — installing unprompted is a
     *  surprise the user should opt into. */
    auto: boolean;
    /** A version the user chose to skip, e.g. "0.4.5". The on-launch check
     *  stays silent for exactly this version; anything newer prompts again,
     *  and a manual "Check for Updates…" ignores it entirely so the menu
     *  item is never dead. */
    skipVersion: string | null;
  };
}

export const DEFAULT_PREFS: Prefs = {
  csv: {
    nullToken: "NULL",
    delimiter: ",",
    emptyIsNull: false,
    lineEnding: "\n",
  },
  updates: {
    auto: false,
    skipVersion: null,
  },
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_PREFS);
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      csv: { ...DEFAULT_PREFS.csv, ...(parsed.csv ?? {}) },
      updates: { ...DEFAULT_PREFS.updates, ...(parsed.updates ?? {}) },
    };
  } catch {
    return clone(DEFAULT_PREFS);
  }
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
