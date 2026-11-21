#!/usr/bin/env bash
# Type-checks the Edge Functions with tsc (no Deno needed) and FAILS on the error classes that crash at runtime:
# unknown / misspelled / used-before-declared / duplicate identifiers and config errors (TS5xxx). Other diagnostics are printed as warnings
# (a few supabase-js typing mismatches are known). Run: bash scripts/check-functions.sh
set -uo pipefail
cd "$(dirname "$0")/.."
out="$(pnpm exec tsc -p supabase/functions/_typecheck/tsconfig.json --pretty false 2>&1)"
fatal="$(printf '%s\n' "$out" | grep -E 'error TS(2304|2552|2448|2451|2454|2300|2307|5[0-9]{3}):' || true)"
others="$(printf '%s\n' "$out" | grep -E 'error TS' | grep -vE 'error TS(2304|2552|2448|2451|2454|2300|2307|5[0-9]{3}):' | wc -l)"
if [[ -n "$fatal" ]]; then
  printf 'Edge Functions: runtime-fatal type errors:\n%s\n' "$fatal" >&2
  exit 1
fi
echo "Edge Functions: no runtime-fatal type error (${others} other diagnostics, non-blocking)."
