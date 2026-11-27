#!/usr/bin/env bash
# CI uniquement (job « images ») : contrôle l'environnement dev (projet raijin-dev) livré par infra/ci/test-dev-env.sh
# À CÔTÉ de la prod, derrière le même Traefik factice : cloisonnement (noms, réseaux, volumes, DNS interne), basicAuth,
# noindex et robots.txt, exceptions publiques d'api-dev (santé, webhook Stripe), Mailpit, et production intacte
# (en-tête interne X-Raijin-Robots sans effet). Identifiant basicAuth factice : DEV_CI_BASIC_AUTH (fake-env.sh).
set -uo pipefail
PORT="${TRAEFIK_CI_PORT:-8443}"
tmp="$(mktemp -d)"
failures=0
ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '::error::%s\n' "$*"; failures=$((failures + 1)); }

[[ -n "${DEV_CI_BASIC_AUTH:-}" ]] || ko "DEV_CI_BASIC_AUTH absent (infra/ci/fake-env.sh)"
printf 'user = "%s"\n' "${DEV_CI_BASIC_AUTH:-}" >"$tmp/auth"
chmod 600 "$tmp/auth"

# check <hôte> <chemin> <code attendu> [motif d'en-tête…]  (« ! » : en-tête interdit) ; AUTH=1 : basicAuth du dev ;
# METHOD / HDR : méthode et en-tête de requête facultatifs.
check() {
  local host="$1" path="$2" want="$3" code pattern opts=()
  shift 3
  [[ "${AUTH:-0}" == 1 ]] && opts+=(--config "$tmp/auth")
  [[ -n "${METHOD:-}" ]] && opts+=(-X "$METHOD")
  [[ -n "${HDR:-}" ]] && opts+=(-H "$HDR")
  code="$(curl -sk --max-time 30 --resolve "$host:$PORT:127.0.0.1" --compressed "${opts[@]}" \
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

echo "== Conteneurs dev (à côté de la prod)"
for name in raijin-dev-postgres raijin-dev-redis raijin-dev-api raijin-dev-web raijin-dev-landing raijin-dev-mailpit \
            raijin-postgres raijin-api raijin-web; do
  state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || echo absent)"
  if [[ "$state" == "running healthy" ]]; then ok "$name $state"; else ko "$name : $state"; fi
done
proj="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' raijin-dev-api 2>/dev/null)"
[[ "$proj" == raijin-dev ]] && ok "projet Compose raijin-dev" || ko "projet de raijin-dev-api : $proj"
published="$(docker ps --filter name=raijin- --format '{{.Names}} {{.Ports}}' | grep -- '->' || true)"
[[ -z "$published" ]] && ok "aucun port publié (prod et dev)" || ko "ports publiés : $published"

echo "== Cloisonnement"
# Réseau d'entrée du dev (docs/DEPLOY.md C2) : option B (traefik-shared, défaut de la CI) = traefik-ci, comme la prod ;
# option A (dedicated) = raijin-dev-edge. Dans les deux cas, jamais le réseau interne de la prod.
edge_mode="$(sed -n 's/^RAIJIN_DEV_EDGE=//p' "${RAIJIN_DEPLOY_BASE:-${RUNNER_TEMP:-/tmp}/raijin-deploy}/dev/env/.env" 2>/dev/null | tail -n 1)"
edge_mode="${edge_mode:-traefik-shared}"
edge_net=traefik-ci
[[ "$edge_mode" == dedicated ]] && edge_net=raijin-dev-edge
for c in raijin-dev-api raijin-dev-web raijin-dev-landing; do
  nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")"
  if [[ " $nets" != *" raijin-internal "* && " $nets" == *" $edge_net "* ]] \
     && { [[ "$edge_mode" != dedicated ]] || [[ " $nets" != *" traefik-ci "* ]]; }; then
    ok "$c : réseaux $nets(option $edge_mode ; jamais le réseau interne de la prod)"
  else
    ko "$c : réseaux inattendus ($nets, option $edge_mode)"
  fi
done
# Mailpit : réseau interne du dev seul (jamais le réseau d'entrée), interface protégée par Mailpit lui-même.
nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' raijin-dev-mailpit)"
[[ "$nets" == "raijin-dev-internal " ]] && ok "raijin-dev-mailpit : réseau interne dev seul" || ko "raijin-dev-mailpit : réseaux $nets"
mp() { docker exec raijin-dev-api node -e "fetch('http://raijin-mailpit:8025/_mailpit/api/v1/messages',{headers:process.argv[1]?{authorization:'Basic '+Buffer.from(process.argv[1]).toString('base64')}:{},signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status),()=>console.log(0))" "${1:-}"; }
code="$(mp)"; [[ "$code" == 401 ]] && ok "Mailpit : API sans mot de passe → 401" || ko "Mailpit : API sans mot de passe → $code"
code="$(mp "${DEV_CI_BASIC_AUTH:-}")"; [[ "$code" == 200 ]] && ok "Mailpit : API avec le mot de passe du dev → 200" || ko "Mailpit : API avec le mot de passe du dev → $code"
seen="$(docker exec raijin-api getent hosts raijin-mailpit 2>/dev/null || true)"
[[ -z "$seen" ]] && ok "prod : raijin-mailpit introuvable depuis le réseau d'entrée" || ko "prod : raijin-mailpit résolu ($seen)"
# Postgres et Redis de la prod : injoignables depuis le dev (réseau interne de la prod seulement).
for target in raijin-postgres:5432 raijin-redis:6379; do
  ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "raijin-internal"}}{{.IPAddress}}{{end}}' "${target%%:*}")"
  if [[ -n "$ip" ]] && docker exec raijin-dev-api node -e "const s=require('net').connect(${target##*:},'$ip');s.setTimeout(4000);s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1))"; then
    ko "l'API dev joint ${target%%:*} de la prod ($ip)"
  else
    ok "l'API dev ne joint pas ${target%%:*} de la prod"
  fi
done
prod_api_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "traefik-ci"}}{{.IPAddress}}{{end}}' raijin-api)"
if docker exec raijin-dev-api node -e "fetch('http://$prod_api_ip:3000/api/v1/health',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))"; then
  if [[ "$edge_mode" == dedicated ]]; then ko "option A : l'API dev joint l'API de la prod ($prod_api_ip)"
  else ok "option B : l'API de la prod est joignable depuis le dev (risque résiduel documenté, docs/SECURITY.md §17)"; fi
else
  if [[ "$edge_mode" == dedicated ]]; then ok "option A : l'API dev ne joint pas l'API de la prod"
  else ok "option B : l'API de la prod n'est pas joignable depuis le dev"; fi
fi
# Nom de service partagé sur le réseau d'entrée (option B) : la prod résout toujours SON Postgres et SON Redis.
prod_pg_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "raijin-internal"}}{{.IPAddress}}{{end}}' raijin-postgres)"
seen="$(docker exec raijin-api getent hosts raijin-postgres | awk '{print $1}' | sort -u | tr '\n' ' ')"
[[ -n "$prod_pg_ip" && "$seen" == "$prod_pg_ip " ]] && ok "prod : raijin-postgres résolu vers le Postgres de la prod seul" || ko "prod : raijin-postgres résolu vers $seen (prod : $prod_pg_ip)"
nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' raijin-dev-postgres)"
[[ "$nets" == "raijin-dev-internal " ]] && ok "raijin-dev-postgres : réseau interne dev seul" || ko "raijin-dev-postgres : réseaux $nets"
[[ "$(docker network inspect -f '{{.Internal}}' raijin-dev-internal)" == true ]] && ok "raijin-dev-internal sans accès extérieur" || ko "raijin-dev-internal n'est pas interne"
for v in raijin-dev-pgdata raijin-dev-redisdata raijin-pgdata raijin-redisdata; do
  docker volume inspect "$v" >/dev/null 2>&1 && ok "volume $v" || ko "volume $v absent"
done
mounted="$(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' raijin-dev-postgres)"
[[ "$mounted" == *raijin-dev-pgdata* && "$mounted" != *"raijin-pgdata "* ]] && ok "Postgres dev sur raijin-dev-pgdata" || ko "Postgres dev monte : $mounted"
# Le nom de service « raijin-postgres » vu depuis l'API dev doit être le Postgres DU DEV.
dev_pg_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "raijin-dev-internal"}}{{.IPAddress}}{{end}}' raijin-dev-postgres)"
seen_ip="$(docker exec raijin-dev-api getent hosts raijin-postgres | awk '{print $1}' | head -n 1)"
[[ -n "$dev_pg_ip" && "$seen_ip" == "$dev_pg_ip" ]] && ok "raijin-postgres résolu vers le Postgres dev ($seen_ip)" || ko "raijin-postgres résolu vers $seen_ip (dev : $dev_pg_ip)"
seen_redis="$(docker exec raijin-dev-api getent hosts raijin-redis | awk '{print $1}' | head -n 1)"
dev_redis_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "raijin-dev-internal"}}{{.IPAddress}}{{end}}' raijin-dev-redis)"
[[ -n "$dev_redis_ip" && "$seen_redis" == "$dev_redis_ip" ]] && ok "raijin-redis résolu vers le Redis dev" || ko "raijin-redis résolu vers $seen_redis (dev : $dev_redis_ip)"
envs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' raijin-dev-api)"
grep -qx 'SMTP_HOST=raijin-mailpit' <<<"$envs" && grep -qx 'MAIL_PROVIDER=smtp' <<<"$envs" && ok "e-mails du dev vers Mailpit" || ko "API dev : SMTP inattendu"
grep -qx 'APP_URL=https://dev.raijinshield.com' <<<"$envs" && ok "APP_URL dev" || ko "API dev : APP_URL inattendue"
grep -qx 'CORS_ORIGINS=https://dev.raijinshield.com' <<<"$envs" && ok "CORS_ORIGINS dev" || ko "API dev : CORS_ORIGINS inattendue"
unset envs
# Mot de passe Redis de la prod refusé par le Redis du dev.
out="$(REDISCLI_AUTH="${REDIS_PASSWORD:-}" docker exec -e REDISCLI_AUTH raijin-dev-redis redis-cli --no-auth-warning --user raijin-api ping 2>&1)"
grep -qE 'WRONGPASS|denied' <<<"$out" && ok "Redis dev : mot de passe de la prod refusé" || ko "Redis dev : $(head -c 120 <<<"$out")"
out="$(REDISCLI_AUTH="${REDIS_DEV_PASSWORD:-}" docker exec -e REDISCLI_AUTH raijin-dev-redis redis-cli --no-auth-warning --user raijin-api ping 2>&1)"
grep -q PONG <<<"$out" && ok "Redis dev : mot de passe du dev accepté" || ko "Redis dev : $(head -c 120 <<<"$out")"
mm="$(REDISCLI_AUTH="${REDIS_DEV_PASSWORD:-}" docker exec -e REDISCLI_AUTH raijin-dev-redis redis-cli --no-auth-warning --user raijin-api info memory 2>&1 | tr -d '\r' | sed -n 's/^maxmemory_human://p')"
[[ "$mm" == 48.00M ]] && ok "Redis dev plafonné à 48 Mo" || ko "Redis dev : maxmemory $mm"

echo "== App dev (basicAuth, noindex)"
check dev.raijinshield.com / 401 'www-authenticate: basic realm="Raijin-dev"'
code="$(curl -sk -o /dev/null -w '%{http_code}' -u 'ci:mauvais-mot-de-passe' --resolve "dev.raijinshield.com:$PORT:127.0.0.1" "https://dev.raijinshield.com:$PORT/" || echo 000)"
[[ "$code" == 401 ]] && ok "dev : mauvais mot de passe → 401" || ko "dev : mauvais mot de passe → $code"
AUTH=1 check dev.raijinshield.com / 200 'x-robots-tag: noindex, nofollow' "content-security-policy: default-src 'self'" \
  "img-src 'self' data: https://api-dev.raijinshield.com" 'strict-transport-security: max-age=63072000'
AUTH=1 check dev.raijinshield.com /api/v1/health 200 'x-robots-tag: noindex'
check dev.raijinshield.com /api/v1/health 401
check dev.raijinshield.com /t/DezXAZ8z7PnrnLZxU5PfJLQ1uXWuqxbUzvsCiAq4Sg8D 401
AUTH=1 check dev.raijinshield.com /t/DezXAZ8z7PnrnLZxU5PfJLQ1uXWuqxbUzvsCiAq4Sg8D 200 'x-robots-tag: noindex' 'content-type: text/html'
check dev.raijinshield.com /robots.txt 200 'x-robots-tag: noindex, nofollow' '!www-authenticate'
grep -q '^Disallow: /$' "$tmp/body" && ok "dev : robots.txt Disallow: /" || ko "dev : robots.txt sans « Disallow: / »"
# Mailpit n'est plus routé par Traefik : /_mailpit/ tombe sur l'app (basicAuth), jamais sur Mailpit.
check dev.raijinshield.com /_mailpit/ 401
code="$(curl -sk --config "$tmp/auth" -o "$tmp/body" -w '%{http_code}' --resolve "dev.raijinshield.com:$PORT:127.0.0.1" "https://dev.raijinshield.com:$PORT/_mailpit/api/v1/messages" || echo 000)"
grep -q '"messages"' "$tmp/body" && ko "dev : Mailpit joignable par Traefik ($code)" || ok "dev : Mailpit non routé par Traefik ($code)"

echo "== Landing dev"
check landing-dev.raijinshield.com / 401 'www-authenticate: basic'
AUTH=1 check landing-dev.raijinshield.com / 200 'x-robots-tag: noindex, nofollow' "form-action 'self' https://dev.raijinshield.com"
# (Liens de la landing vers dev.raijinshield.com : non contrôlés ici, l'image testée est celle de la prod réétiquetée ;
# en déploiement continu, deploy.yml construit la landing dev avec APP_DOMAIN=dev.raijinshield.com.)
check landing-dev.raijinshield.com /robots.txt 200 'x-robots-tag: noindex, nofollow'
grep -q '^Disallow: /$' "$tmp/body" && ok "landing dev : robots.txt Disallow: /" || ko "landing dev : robots.txt sans « Disallow: / »"
check www.landing-dev.raijinshield.com / 404

echo "== API dev (api-dev.raijinshield.com)"
check api-dev.raijinshield.com /api/v1/health 200 'x-robots-tag: noindex, nofollow' '!www-authenticate'
grep -q '"database":"up"' "$tmp/body" && ok "api-dev : base dev joignable" || ko "api-dev : base indisponible"
check api-dev.raijinshield.com /api/v1/push/vapid-public-key 401 'www-authenticate: basic'
# Webhook Stripe : jamais derrière la basicAuth (la signature Stripe est contrôlée par l'API, qui répond elle-même).
code="$(curl -sk -o /dev/null -D "$tmp/h" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' \
  --resolve "api-dev.raijinshield.com:$PORT:127.0.0.1" "https://api-dev.raijinshield.com:$PORT/api/v1/billing/webhook" || echo 000)"
if [[ "$code" =~ ^[45][0-9][0-9]$ && "$code" != 401 ]] && ! grep -qi '^www-authenticate' "$tmp/h"; then
  ok "api-dev : webhook Stripe joignable sans basicAuth (réponse de l'API : $code)"
else
  ko "api-dev : webhook Stripe → $code (réponse de l'API attendue, sans basicAuth)"
fi

echo "== Accès direct du dev vers la prod (en-tête X-Raijin-Edge, docs/SECURITY.md §17)"
# Option B : raijin-dev-api partage le réseau du Traefik avec raijin-api et raijin-bench-api. Un appel direct (sans
# Traefik, donc sans l'en-tête secret) doit recevoir 403, même avec un faux en-tête ; le même chemin via Traefik passe.
# Les appels visent l'IP de chaque conteneur de la prod sur le réseau d'entrée, jamais son nom : le dev reprend les
# mêmes noms de service (raijin-api…), que Docker résout depuis raijin-dev-api vers le dev lui-même (alias réseau).
# direct <ip:port><chemin> [en-tête] → code HTTP vu depuis raijin-dev-api (node, sans outil réseau dans l'image).
direct() {
  docker exec -e RJ_URL="http://$1" -e RJ_HDR="${2:-}" raijin-dev-api node -e '
    const h = process.env.RJ_HDR ? { "X-Raijin-Edge": process.env.RJ_HDR } : {};
    fetch(process.env.RJ_URL, { headers: h, signal: AbortSignal.timeout(15000) })
      .then((r) => console.log(r.status), () => console.log("000"));' 2>/dev/null || echo 000
}
# IP sur le réseau d'entrée de la prod (traefik-ci, quel que soit le mode du dev).
prod_edge_ip() { docker inspect -f "{{with index .NetworkSettings.Networks \"traefik-ci\"}}{{.IPAddress}}{{end}}" "$1" 2>/dev/null || true; }
# Valeur fausse construite à l'exécution (aucun littéral ressemblant à une clé dans le dépôt).
wrong_edge="$(printf 'faux%.0s' 1 2 3 4)"
if [[ "$edge_mode" == dedicated ]]; then
  ok "option A : appels directs vers la prod sans objet (réseaux d'entrée séparés)"
else
  prod_ip="$(prod_edge_ip raijin-api)"
  [[ -n "$prod_ip" ]] || ko "raijin-api : aucune IP sur traefik-ci"
  code="$(direct "$prod_ip:3000/api/v1/billing/plans")"
  [[ "$code" == 403 ]] && ok "dev → raijin-api ($prod_ip) en direct : 403" || ko "dev → raijin-api ($prod_ip) en direct : $code au lieu de 403"
  code="$(direct "$prod_ip:3000/api/v1/billing/plans" "$wrong_edge")"
  [[ "$code" == 403 ]] && ok "dev → raijin-api en direct, faux X-Raijin-Edge : 403" || ko "dev → raijin-api, faux en-tête : $code au lieu de 403"
  code="$(direct "$prod_ip:3000/api/v1/health")"
  [[ "$code" == 200 ]] && ok "dev → raijin-api /health en direct : 200 (santé exemptée)" || ko "dev → raijin-api /health : $code au lieu de 200"
fi
check api.raijinshield.com /api/v1/billing/plans 200
if docker inspect raijin-bench-api >/dev/null 2>&1; then
  bench_ip="$(prod_edge_ip raijin-bench-api)"
  if [[ "$edge_mode" != dedicated ]]; then
    code="$(direct "$bench_ip:3000/api/status")"
    [[ "$code" == 403 ]] && ok "dev → raijin-bench-api ($bench_ip) en direct : 403" || ko "dev → raijin-bench-api ($bench_ip) en direct : $code au lieu de 403"
  fi
  # Via Traefik (basicAuth du banc) : l'en-tête passe, la session manque → 401 de l'API du banc, jamais 403.
  printf 'user = "%s"\n' "${BENCH_CI_BASIC_AUTH:-}" >"$tmp/bench-auth"; chmod 600 "$tmp/bench-auth"
  code="$(curl -sk --max-time 30 --config "$tmp/bench-auth" --resolve "banc.raijinshield.com:$PORT:127.0.0.1" -o /dev/null \
    -w '%{http_code}' "https://banc.raijinshield.com:$PORT/api/status" || echo 000)"
  [[ "$code" == 401 ]] && ok "banc via Traefik : en-tête accepté (401 sans session)" || ko "banc via Traefik : $code au lieu de 401"
fi

echo "== Production intacte"
HDR='X-Raijin-Robots: deny' check raijinshield.com /robots.txt 200 '!x-robots-tag'
if grep -q '^Disallow: /$' "$tmp/body"; then ko "prod : l'en-tête interne a changé robots.txt"; else ok "prod : robots.txt de la landing inchangé (en-tête interne ignoré)"; fi
HDR='X-Raijin-Robots: deny' check app.raijinshield.com /robots.txt 404
check app.raijinshield.com / 200 '!x-robots-tag' '!www-authenticate'
check api.raijinshield.com /api/v1/health 200 '!www-authenticate'

rm -r "$tmp"
if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Environnement dev : tous les contrôles sont verts."
