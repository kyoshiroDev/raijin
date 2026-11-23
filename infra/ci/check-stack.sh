#!/usr/bin/env bash
# CI uniquement (job « images ») : contrôle la pile Raijin démarrée par infra/deploy.sh derrière un Traefik
# factice (certificat par défaut, port 127.0.0.1:$TRAEFIK_CI_PORT) : healthchecks, routage (même origine /api et
# /t, www → 301), règles nginx (.html → 301, cache, 405) et en-têtes de sécurité posés par les labels Traefik.
set -uo pipefail
PORT="${TRAEFIK_CI_PORT:-8443}"
tmp="$(mktemp -d)"
failures=0

ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '::error::%s\n' "$*"; failures=$((failures + 1)); }

# check <hôte> <chemin> <code attendu> [motif d'en-tête…]   (motif préfixé par « ! » : en-tête interdit)
check() {
  local host="$1" path="$2" want="$3" code pattern
  shift 3
  code="$(curl -sk --max-time 30 --resolve "$host:$PORT:127.0.0.1" --compressed \
    -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' "https://$host:$PORT$path" || echo 000)"
  tr -d '\r' <"$tmp/headers" >"$tmp/h"
  if [[ "$code" == "$want" ]]; then ok "$host$path → $code"; else ko "$host$path : $code au lieu de $want"; fi
  for pattern in "$@"; do
    if [[ "$pattern" == '!'* ]]; then
      if grep -qiE "${pattern:1}" "$tmp/h"; then ko "$host$path : en-tête interdit présent ($pattern)"; fi
    elif ! grep -qiE "$pattern" "$tmp/h"; then
      ko "$host$path : en-tête attendu absent ($pattern)"
    fi
  done
}

echo "== Conteneurs"
for name in raijin-postgres raijin-redis raijin-api raijin-web raijin-landing; do
  state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || echo absent)"
  if [[ "$state" == "running healthy" ]]; then ok "$name $state"; else ko "$name : $state"; fi
done
# Aucun port publié par Raijin (seul Traefik factice en publie un).
published="$(docker ps --filter name=raijin- --format '{{.Names}} {{.Ports}}' | grep -- '->' || true)"
if [[ -z "$published" ]]; then ok "aucun port publié"; else ko "ports publiés : $published"; fi

common=('strict-transport-security: max-age=63072000; includeSubDomains; preload' 'x-content-type-options: nosniff'
  'x-frame-options: DENY' '!^server:')

echo "== Landing"
check raijinshield.com / 200 "${common[@]}" \
  "content-security-policy: default-src 'self'; script-src 'self' https://www.googletagmanager.com; style-src 'self';" \
  "form-action 'self' https://app.raijinshield.com" 'referrer-policy: strict-origin-when-cross-origin' \
  'permissions-policy: camera=\(\)' 'cross-origin-opener-policy: same-origin' 'cache-control: public, max-age=0' \
  'content-encoding: gzip'
check raijinshield.com /tarifs 200 'content-type: text/html'
check raijinshield.com '/tarifs.html?utm_source=ci' 301 'location: /tarifs\?utm_source=ci'
check raijinshield.com /tarifs/ 301 'location: /tarifs$'
check raijinshield.com /page-inexistante 404
# Redirection ouverte : jamais de Location vers « //hôte » (Traefik peut normaliser le chemin, nginx renvoie alors
# une redirection relative vers /evil.example, sans danger).
curl -sk -o /dev/null -D "$tmp/h" --resolve "raijinshield.com:$PORT:127.0.0.1" "https://raijinshield.com:$PORT//evil.example/" || true
# shellcheck disable=SC1003
if grep -qiE '^location: *(https?:)?//|^location: */\\' "$tmp/h"; then ko "redirection ouverte via //evil.example/"; else ok "pas de redirection ouverte (//evil.example/)"; fi
asset="$(docker exec raijin-landing sh -c 'ls /usr/share/nginx/html/_astro | head -n 1')"
[[ -n "$asset" ]] && check raijinshield.com "/_astro/$asset" 200 'cache-control: public, max-age=31536000, immutable'
check www.raijinshield.com '/guides?x=1' 301 'location: https://raijinshield.com/guides\?x=1'
code="$(curl -sk -o /dev/null -w '%{http_code}' -X POST --resolve "raijinshield.com:$PORT:127.0.0.1" "https://raijinshield.com:$PORT/")"
if [[ "$code" == 405 ]]; then ok "POST landing → 405"; else ko "POST landing : $code au lieu de 405"; fi

echo "== App"
check app.raijinshield.com / 200 "${common[@]}" \
  "content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://api.raijinshield.com;" \
  "frame-ancestors 'none'" 'cache-control: no-cache'
check app.raijinshield.com /analyse 200 'content-type: text/html'
check app.raijinshield.com /fichier-absent.js 404
main_js="$(docker exec raijin-web sh -c 'ls /usr/share/nginx/html | grep -E "^main-.*\.js$" | head -n 1')"
[[ -n "$main_js" ]] && check app.raijinshield.com "/$main_js" 200 'cache-control: public, max-age=31536000, immutable'
check app.raijinshield.com /ngsw-worker.js 200 'cache-control: no-cache'

echo "== API (même origine et sous-domaine)"
check app.raijinshield.com /api/v1/health 200 "content-security-policy: default-src 'none'" 'x-robots-tag: noindex' \
  'strict-transport-security: max-age=63072000'
if grep -q '"database":"up"' "$tmp/body"; then ok "base joignable depuis l'API"; else ko "health : base indisponible"; fi
check api.raijinshield.com /api/v1/health 200 'x-robots-tag: noindex, nofollow' '!^x-powered-by:'
check app.raijinshield.com /t/DezXAZ8z7PnrnLZxU5PfJLQ1uXWuqxbUzvsCiAq4Sg8D 200 'content-type: text/html' \
  "content-security-policy: default-src 'self'; script-src 'self'" 'cross-origin-opener-policy: same-origin'

rm -r "$tmp"
if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Tous les contrôles sont verts."
