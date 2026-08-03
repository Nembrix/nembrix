/**
 * Compare two semver strings. Returns >0 if a>b, <0 if a<b, 0 if equal.
 * Numeric core (major.minor.patch) compared numerically; a version WITH a
 * pre-release tag (0.2.0-beta.1) sorts BEFORE the same core release
 * (0.2.0) per semver. Good enough for our release gating — we don't need
 * full pre-release identifier ordering.
 *
 * Shared by bump-version.ts and its test.
 */
export function semverCmp(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const [maj, min, pat] = core.split(".").map((n) => parseInt(n, 10));
    return { maj, min, pat, pre: pre ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.maj !== pb.maj) return pa.maj - pb.maj;
  if (pa.min !== pb.min) return pa.min - pb.min;
  if (pa.pat !== pb.pat) return pa.pat - pb.pat;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre < pb.pre ? -1 : 1;
}
