#!/usr/bin/env bash
# Report GitHub release download counts for Nembrix.
#
# Downloads are the one usage signal we collect for free without touching
# the "no telemetry by default" promise — GitHub counts every release-asset
# fetch. Caveats: the count includes auto-updater fetches, and does NOT
# include Homebrew or mirror installs, so treat it as a directional trend,
# not an exact install count.
#
# Usage:
#   scripts/download-stats.sh            # totals per release + grand total
#   scripts/download-stats.sh --by-asset # per-asset breakdown (which OS/format)
#
# Requires: gh (authenticated), jq.
set -euo pipefail

REPO="${NEMBRIX_REPO:-oesukam/nembrix}"

if ! command -v gh >/dev/null; then echo "need gh CLI" >&2; exit 1; fi
if ! command -v jq >/dev/null; then echo "need jq" >&2; exit 1; fi

releases="$(gh api "repos/${REPO}/releases" --paginate)"

if [[ "${1:-}" == "--by-asset" ]]; then
  echo "Downloads per asset (all releases):"
  echo "$releases" | jq -r '
    .[] | .tag_name as $t | .assets[]
    | "\(.download_count)\t\($t)\t\(.name)"' | sort -rn
  exit 0
fi

echo "Downloads per release:"
echo "$releases" | jq -r '
  .[]
  | "\([.assets[].download_count] | add // 0)\t\(.tag_name) [\(if .prerelease then "pre" else "stable" end)]"' \
  | sort -rn | awk -F'\t' '{printf "  %6d  %s\n", $1, $2}'

total="$(echo "$releases" | jq '[.[].assets[].download_count] | add // 0')"
echo "-------------------------------------"
printf "  %6d  TOTAL\n" "$total"
