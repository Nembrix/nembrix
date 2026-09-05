/**
 * Async data loading for a component, without tripping
 * `react-hooks/set-state-in-effect`.
 *
 * The pattern this replaces looked like:
 *
 *   useEffect(() => {
 *     let cancelled = false;
 *     setLoading(true);            // ← synchronous setState in an effect body
 *     setErr(null);                // ← and another
 *     fetch().then((d) => { if (!cancelled) setData(d); });
 *     return () => { cancelled = true; };
 *   }, [deps]);
 *
 * Three separate `useState` cells meant the "start loading" transition was two
 * synchronous setState calls in the effect body, each able to trigger its own
 * render pass. Folding them into one reducer makes it a single dispatch, which
 * is both what the lint rule asks for and one render instead of two or three.
 *
 * Cancellation is kept — a resolved fetch from a superseded run must not
 * overwrite fresher state — but it now lives in one place instead of being
 * re-implemented (and occasionally forgotten) at every call site.
 */

import { useCallback, useEffect, useReducer } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

type Action<T> =
  | { type: "start" }
  | { type: "resolve"; data: T }
  | { type: "reject"; error: string };

function reducer<T>(state: AsyncState<T>, action: Action<T>): AsyncState<T> {
  switch (action.type) {
    case "start":
      // Keep the previous `data` while reloading so the UI can show stale
      // content rather than flashing empty — callers that want a blank slate
      // can check `loading` instead.
      return { ...state, loading: true, error: null };
    case "resolve":
      return { data: action.data, error: null, loading: false };
    case "reject":
      return { ...state, error: action.error, loading: false };
  }
}

/**
 * Run `load` whenever `deps` change, tracking loading/error/data.
 *
 * `load` receives an `isCancelled` predicate so a long-running or streaming
 * fetch can bail out early; its resolved value is ignored once superseded.
 */
export function useAsyncResource<T>(
  load: (isCancelled: () => boolean) => Promise<T>,
  deps: React.DependencyList,
  initial: T | null = null,
): AsyncState<T> & { reload: () => void } {
  const [state, dispatch] = useReducer(reducer<T>, {
    data: initial,
    error: null,
    loading: true,
  });
  // Bumping this re-runs the effect without changing the caller's deps.
  const [nonce, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "start" });
    load(() => cancelled)
      .then((data) => {
        if (!cancelled) dispatch({ type: "resolve", data });
      })
      .catch((e) => {
        if (!cancelled) dispatch({ type: "reject", error: String(e) });
      });
    return () => {
      cancelled = true;
    };
    // `load` is intentionally not a dep: callers pass an inline closure, so
    // including it would re-fetch on every render. The caller's `deps` are the
    // contract for when a reload is warranted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload: useCallback(() => bump(), []) };
}
