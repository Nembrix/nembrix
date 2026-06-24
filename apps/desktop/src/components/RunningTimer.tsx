import { useEffect, useState } from "react";

/**
 * Live elapsed timer used in the data toolbar + status pill while a query
 * is running. Ticks at ~10Hz off a local interval so the global store
 * doesn't re-render on every frame.
 *
 * Render rule:
 *   - running=true with startedAt → ticking "1.2 s" / "234 ms"
 *   - running=false with elapsedMs → static "Done · 234 ms"
 *   - neither → null
 */
export default function RunningTimer({
  running,
  startedAt,
  elapsedMs,
  prefix = "",
}: {
  running?: boolean;
  startedAt?: number;
  elapsedMs?: number;
  /** Optional separator prefix, e.g. "· " — keeps the toolbar tidy. */
  prefix?: string;
}) {
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(h);
  }, [running]);

  if (running && startedAt != null) {
    return <span className="muted">{prefix}{formatMs(now - startedAt)}</span>;
  }
  if (!running && elapsedMs != null) {
    return <span className="muted">{prefix}{formatMs(elapsedMs)}</span>;
  }
  return null;
}

/** Render ms compactly: <1s as integer ms; >=1s as "1.23 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
