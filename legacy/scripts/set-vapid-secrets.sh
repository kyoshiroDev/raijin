#!/usr/bin/env bash
# Pushes the VAPID key pair from .secrets/vapid.json to the Supabase Edge Function secrets.
# Validates the key formats first and never prints any key.
# Usage: bash scripts/set-vapid-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${SUPABASE_PROJECT_REF:-jntknbxdpetvcmoejncm}"
FILE=".secrets/vapid.json"
[[ -s "$FILE" ]] || { echo "missing $FILE" >&2; exit 1; }

read_key() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = j[process.argv[2]];
    const ok = { publicKey: /^B[A-Za-z0-9_-]{86}$/, privateKey: /^[A-Za-z0-9_-]{43}$/, subject: /^mailto:[^\s@]+@[^\s@]+$/ }[process.argv[2]];
    if (typeof v !== "string" || !ok.test(v)) { console.error("invalid " + process.argv[2] + " in vapid.json"); process.exit(1); }
    process.stdout.write(v);
  ' "$FILE" "$1"
}

pub="$(read_key publicKey)"
priv="$(read_key privateKey)"
subject="$(read_key subject)"

if npx --yes supabase@3.2.0 secrets set --remote="$REF" --yes \
  VAPID_PUBLIC_KEY="$pub" VAPID_PRIVATE_KEY="$priv" VAPID_SUBJECT="$subject" >/dev/null 2>&1; then
  echo "VAPID secrets OK (public ${#pub} chars, private ${#priv} chars)"
else
  echo "supabase secrets set failed" >&2
  exit 1
fi
