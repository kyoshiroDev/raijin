#!/usr/bin/env bash
# CI uniquement (job « images ») : contrôle la pile Raijin démarrée par infra/deploy.sh derrière un Traefik
# factice (certificat par défaut, port 127.0.0.1:$TRAEFIK_CI_PORT) : healthchecks, routage (même origine /api et
# /t, www → 301), règles nginx (.html → 301, cache, 405) et en-têtes de sécurité posés par les labels Traefik.
# ACL Redis par application (M6) ; banc (profil « bench », s'il tourne) : double verrou, noindex, routage, SSE.
# Mots de passe lus dans l'environnement (exportés par infra/ci/fake-env.sh), jamais passés en argument.
set -uo pipefail
PORT="${TRAEFIK_CI_PORT:-8443}"
tmp="$(mktemp -d)"
failures=0

ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '::error::%s\n' "$*"; failures=$((failures + 1)); }

# check <hôte> <chemin> <code attendu> [motif d'en-tête…]   (motif préfixé par « ! » : en-tête interdit)
# CHECK_AUTH=1 : envoie l'identifiant basicAuth factice du banc (fichier de configuration curl, pas d'argument).
check() {
  local host="$1" path="$2" want="$3" code pattern auth=()
  shift 3
  [[ "${CHECK_AUTH:-0}" == 1 ]] && auth=(--config "$tmp/bench-auth")
  code="$(curl -sk --max-time 30 --resolve "$host:$PORT:127.0.0.1" --compressed "${auth[@]}" \
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

echo "== Redis (ACL par application)"
# rcli <utilisateur> <variable du mot de passe> <commande…> : le mot de passe passe par l'environnement de docker exec.
rcli() {
  local user="$1" var="$2"
  shift 2
  REDISCLI_AUTH="${!var:-}" docker exec -e REDISCLI_AUTH raijin-redis redis-cli --no-auth-warning --user "$user" "$@" 2>&1
}
# Refus attendus : NOPERM (ACL), « No permissions » (ACL dans un script), « command not allowed » (DEBUG désactivé
# par la configuration de Redis, refus avant l'ACL). Toute autre réponse, succès compris, est un échec.
DENIED='NOPERM|No permissions|command not allowed'
# expect <libellé> <motif attendu (ERE)> <commande…>
expect() {
  local label="$1" want="$2" out
  shift 2
  out="$("$@")"
  if grep -qE "$want" <<<"$out"; then ok "$label"; else ko "$label : $(head -c 200 <<<"$out")"; fi
}
expect "raijin-api écrit raijin:*" '^OK$' rcli raijin-api REDIS_PASSWORD set raijin:ci:acl api EX 120
expect "raijin-api lit raijin:*" '^api$' rcli raijin-api REDIS_PASSWORD get raijin:ci:acl
expect "raijin-api ne lit pas raijin-bench:*" 'NOPERM' rcli raijin-api REDIS_PASSWORD get raijin-bench:ci:acl
expect "raijin-api n'écrit pas raijin-bench:*" 'NOPERM' rcli raijin-api REDIS_PASSWORD set raijin-bench:ci:acl x
expect "raijin-api : EVAL ne contourne pas l'ACL" "$DENIED" \
  rcli raijin-api REDIS_PASSWORD eval "return redis.call('get','raijin-bench:ci:acl')" 0
expect "raijin-api : file BullMQ raijin:<file> autorisée" '^[0-9]+$' rcli raijin-api REDIS_PASSWORD hset raijin:ci-queue:meta v 1
# Globbing coupé : « raijin-bench:* » doit arriver tel quel à KEYS (sinon le shell le développe).
set -f
for cmd in 'keys raijin-bench:*' 'keys raijin:*' 'scan 0' 'flushall' 'config get dir' 'client list' 'debug object raijin:ci:acl' 'randomkey'; do
  # shellcheck disable=SC2086
  expect "raijin-api : ${cmd% *} refusé" "$DENIED" rcli raijin-api REDIS_PASSWORD $cmd
done
set +f
expect "raijin-api : INFO autorisé (BullMQ, ioredis)" 'redis_version:' rcli raijin-api REDIS_PASSWORD info server
expect "raijin-api : CLIENT SETNAME autorisé (BullMQ)" '^OK$' rcli raijin-api REDIS_PASSWORD client setname raijin-ci
expect "utilisateur default désactivé (sans mot de passe)" 'NOAUTH' docker exec raijin-redis env -u REDISCLI_AUTH redis-cli ping
expect "utilisateur default désactivé (mot de passe de l'API)" 'WRONGPASS|denied' rcli default REDIS_PASSWORD ping
expect "mot de passe de l'API refusé pour raijin-bench" 'WRONGPASS|denied' rcli raijin-bench REDIS_PASSWORD ping
if [[ -n "${REDIS_BENCH_PASSWORD:-}" ]]; then
  expect "raijin-bench écrit raijin-bench:*" '^OK$' rcli raijin-bench REDIS_BENCH_PASSWORD set raijin-bench:ci:acl bench EX 120
  expect "raijin-bench ne lit pas raijin:*" 'NOPERM' rcli raijin-bench REDIS_BENCH_PASSWORD get raijin:ci:acl
  expect "raijin-bench n'écrit pas raijin:*" 'NOPERM' rcli raijin-bench REDIS_BENCH_PASSWORD set raijin:ci:acl x
  expect "raijin-bench : file BullMQ raijin-bench:<file> autorisée" '^[0-9]+$' \
    rcli raijin-bench REDIS_BENCH_PASSWORD hset raijin-bench:ci-queue:meta v 1
  expect "raijin-bench : FLUSHALL refusé" "$DENIED" rcli raijin-bench REDIS_BENCH_PASSWORD flushall
  rcli raijin-bench REDIS_BENCH_PASSWORD del raijin-bench:ci:acl raijin-bench:ci-queue:meta >/dev/null
fi
rcli raijin-api REDIS_PASSWORD del raijin:ci:acl raijin:ci-queue:meta >/dev/null

if docker inspect raijin-bench-api >/dev/null 2>&1; then
  echo "== Banc (profil bench)"
  for name in raijin-bench-api raijin-bench-web; do
    state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || echo absent)"
    if [[ "$state" == "running healthy" ]]; then ok "$name $state"; else ko "$name : $state"; fi
  done
  [[ -n "${BENCH_CI_BASIC_AUTH:-}" ]] || ko "BENCH_CI_BASIC_AUTH absent (infra/ci/fake-env.sh)"
  printf 'user = "%s"\n' "${BENCH_CI_BASIC_AUTH:-}" >"$tmp/bench-auth"
  chmod 600 "$tmp/bench-auth"
  bench_common=('x-robots-tag: noindex, nofollow' 'strict-transport-security: max-age=63072000' '!^server:')
  # Verrou 1 : basicAuth Traefik partout (front, API, robots.txt), mauvais mot de passe compris.
  check banc.raijinshield.com / 401 'www-authenticate: basic'
  check banc.raijinshield.com /api/health 401 'www-authenticate: basic'
  check banc.raijinshield.com /robots.txt 401
  code="$(curl -sk -o /dev/null -w '%{http_code}' -u 'ci:mauvais-mot-de-passe' --resolve "banc.raijinshield.com:$PORT:127.0.0.1" \
    "https://banc.raijinshield.com:$PORT/" || echo 000)"
  if [[ "$code" == 401 ]]; then ok "banc : mauvais mot de passe → 401"; else ko "banc : mauvais mot de passe → $code"; fi
  # Avec basicAuth : front servi, jamais indexé.
  CHECK_AUTH=1 check banc.raijinshield.com / 200 "${bench_common[@]}" "content-security-policy: default-src 'self'" \
    'referrer-policy: no-referrer' 'cache-control: no-cache'
  CHECK_AUTH=1 check banc.raijinshield.com /robots.txt 200 "${bench_common[@]}"
  if grep -q '^Disallow: /$' "$tmp/body"; then ok "banc : robots.txt Disallow: /"; else ko "banc : robots.txt sans « Disallow: / »"; fi
  # /api/ → raijin-bench-api (JSON de l'API, pas l'index.html du front).
  CHECK_AUTH=1 check banc.raijinshield.com /api/health 200 "${bench_common[@]}" 'content-type: application/json'
  if grep -q '"status":"ok"' "$tmp/body"; then ok "banc : /api/ routé vers raijin-bench-api"; else ko "banc : /api/health ne vient pas de l'API du banc"; fi
  # Verrou 2 : auth applicative (basicAuth accepté, aucune session) → 401 de l'API, en-tête Authorization retiré.
  CHECK_AUTH=1 check banc.raijinshield.com /api/status 401 "${bench_common[@]}" '!www-authenticate'
  CHECK_AUTH=1 check banc.raijinshield.com /api/events 401 "${bench_common[@]}" '!www-authenticate'
  # SSE : routeur dédié sans compression (et Traefik ne met pas en tampon) ; flux réel testé en e2e (job e2e).
  mw="$(docker inspect -f '{{index .Config.Labels "traefik.http.routers.raijin-bench-events.middlewares"}}' raijin-bench-api)"
  if [[ -n "$mw" && "$mw" != *compress* && "$mw" == raijin-bench-auth,* ]]; then
    ok "banc : /api/events sans compression, derrière basicAuth ($mw)"
  else
    ko "banc : middlewares du routeur SSE inattendus ($mw)"
  fi
  # Cloisonnement Postgres vu depuis l'API du banc : son URL ne vise que raijin_bench avec l'utilisateur raijin_bench.
  url_user="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' raijin-bench-api \
    | sed -n 's|^BENCH_DATABASE_URL=postgresql://\([^:]*\):.*@raijin-postgres:5432/\([^?]*\).*|\1/\2|p')"
  if [[ "$url_user" == raijin_bench/raijin_bench ]]; then ok "banc : base raijin_bench, utilisateur raijin_bench"; else ko "banc : BENCH_DATABASE_URL inattendue ($url_user)"; fi
fi

rm -r "$tmp"
if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Tous les contrôles sont verts."
