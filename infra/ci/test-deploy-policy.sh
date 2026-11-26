#!/usr/bin/env bash
# Contrôles de la porte de déploiement (infra/lib/deploy_policy.py) : configurations réelles prod et dev ACCEPTÉES,
# livraisons dangereuses REFUSÉES (privilège, port publié, montage de l'hôte, réseau ou volume d'un autre projet,
# domaine d'un autre site, tableau de bord Traefik, env_file de la prod depuis le dev ; archive avec lien symbolique,
# « .. » ou chemin absolu ; étiquette d'image étrangère). Sans démon Docker (seul `docker compose config` est utilisé).
# Lancé par le job « infra » de .github/workflows/ci.yml ; aussi en local : infra/ci/test-deploy-policy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
policy=infra/lib/deploy_policy.py
work="$(mktemp -d)"
trap 'rm -r -- "$work"' EXIT
failures=0
ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '::error::%s\n' "$*"; failures=$((failures + 1)); }

# Fichiers de variables factices (valeurs de remplissage, aucun secret).
fill="remplissage-$(openssl rand -hex 16)"
cat >"$work/prod.env" <<EOF
TRAEFIK_NETWORK=traefik-ci
TRAEFIK_CERTRESOLVER=ci
LANDING_DOMAIN=raijinshield.com
APP_DOMAIN=app.raijinshield.com
API_DOMAIN=api.raijinshield.com
POSTGRES_SUPERUSER_PASSWORD=$fill
RAIJIN_DB_PASSWORD=$fill
BENCH_DB_PASSWORD=$fill
REDIS_PASSWORD=$fill
EOF
sed -e 's/^LANDING_DOMAIN=.*/LANDING_DOMAIN=landing-dev.raijinshield.com/' -e 's/^APP_DOMAIN=.*/APP_DOMAIN=dev.raijinshield.com/' \
  -e 's/^API_DOMAIN=.*/API_DOMAIN=api-dev.raijinshield.com/' "$work/prod.env" >"$work/dev.env"
printf "RAIJIN_NAME=raijin-dev\nDEV_BASIC_AUTH_USERS='ci:\$apr1\$remplissage'\n" >>"$work/dev.env"
mkdir -p "$work/envdir/prod" "$work/envdir/dev"
: >"$work/envdir/prod/.env.api"; : >"$work/envdir/prod/.env.bench-api"; : >"$work/envdir/dev/.env.api"
prod_hosts=(raijinshield.com www.raijinshield.com app.raijinshield.com api.raijinshield.com banc.raijinshield.com)
dev_hosts=(landing-dev.raijinshield.com dev.raijinshield.com api-dev.raijinshield.com)

# render <env> <dossier infra> [fichier supplémentaire…] : JSON de la configuration, comme deploy-gate.sh.
render() {
  local env="$1" dir="$2" files=()
  shift 2
  files=(-f "$dir/docker-compose.yml")
  [[ "$env" == dev ]] && files+=(-f "$dir/docker-compose.env-dev.yml")
  for extra in "$@"; do files+=(-f "$extra"); done
  local name=raijin profiles=(--profile tools --profile bench)
  [[ "$env" == dev ]] && name=raijin-dev profiles=(--profile tools)
  RAIJIN_NAME="$name" RAIJIN_API_ENV_FILE="$work/envdir/$env/.env.api" RAIJIN_BENCH_API_ENV_FILE="$work/envdir/$env/.env.bench-api" \
    docker compose -p "$name" --env-file "$work/$env.env" "${files[@]}" "${profiles[@]}" \
    config --format json "$([[ "${NOINTERP:-0}" == 1 ]] && echo --no-interpolate || echo --no-env-resolution)"
}
judge() {
  local env="$1" dir="$2"
  shift 2
  local name=raijin hosts=("${prod_hosts[@]}")
  [[ "$env" == dev ]] && name=raijin-dev hosts=("${dev_hosts[@]}")
  render "$env" "$dir" "$@" 2>/dev/null | python3 "$policy" compose "$name" "$dir" traefik-ci \
    "$work/envdir/$env/.env.api" "$work/envdir/$env/.env.bench-api" -- "${hosts[@]}" >"$work/out" 2>&1 || return 1
  NOINTERP=1 render "$env" "$dir" "$@" 2>/dev/null | python3 "$policy" envfiles "$(cd "$dir" && pwd)" >"$work/out" 2>&1
}
accept() { if judge "$@"; then ok "accepté : $1 ${3:-(configuration réelle)}"; else ko "refusé à tort : $1 ${3:-} $(tr '\n' ' ' <"$work/out" | head -c 400)"; fi; }
reject() {
  local label="$1"; shift
  if judge "$@"; then ko "accepté à tort : $label"; else ok "refusé : $label ($(head -n 1 "$work/out"))"; fi
}
overlay() { printf '%s\n' "$2" >"$work/$1.yml"; echo "$work/$1.yml"; }

echo "== Configurations réelles"
accept prod infra
accept dev infra

echo "== Livraisons dangereuses (dev)"
reject "privileged" dev infra "$(overlay privileged 'services: {raijin-web: {privileged: true}}')"
reject "port publié" dev infra "$(overlay ports 'services: {raijin-web: {ports: ["8080:8080"]}}')"
reject "montage de / (hôte)" dev infra "$(overlay bind 'services: {raijin-web: {volumes: ["/:/host:ro"]}}')"
reject "socket Docker" dev infra "$(overlay sock 'services: {raijin-api: {volumes: ["/var/run/docker.sock:/var/run/docker.sock"]}}')"
reject "cap_add" dev infra "$(overlay capadd 'services: {raijin-api: {cap_add: [SYS_ADMIN]}}')"
reject "network_mode host" dev infra "$(overlay nethost 'services: {raijin-web: {network_mode: host, networks: !reset null}}')"
reject "domaine de la prod depuis le dev" dev infra "$(overlay hijack 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.rule=Host(`app.raijinshield.com`)"]}}')"
reject "domaine d'un autre site" dev infra "$(overlay mtc 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-x.rule=Host(`mytradingcoach.example`)"]}}')"
reject "HostRegexp" dev infra "$(overlay regexp 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-x.rule=HostRegexp(`.+`)"]}}')"
reject "tableau de bord Traefik (api@internal)" dev infra "$(overlay dash 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.service=api@internal"]}}')"
reject "routeur au nom de la prod" dev infra "$(overlay prodname 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-web.rule=Host(`dev.raijinshield.com`)"]}}')"
reject "middleware forwardAuth" dev infra "$(overlay fwd 'services: {raijin-web: {labels: ["traefik.http.middlewares.raijin-dev-fa.forwardauth.address=http://x"]}}')"
reject "service vers une URL" dev infra "$(overlay url 'services: {raijin-web: {labels: ["traefik.http.services.raijin-dev-web.loadbalancer.server.url=http://mtc:3000"]}}')"
reject "routeur TCP" dev infra "$(overlay tcp 'services: {raijin-web: {labels: ["traefik.tcp.routers.raijin-dev-t.rule=HostSNI(`*`)"]}}')"
reject "volume de la prod" dev infra "$(overlay vol 'volumes: {raijin-pgdata: {name: raijin-pgdata}}')"
reject "volume externe" dev infra "$(overlay volext 'services: {raijin-web: {volumes: ["x:/data"]}}
volumes: {x: {external: true, name: mtc-data}}')"
reject "volume local monté sur l'hôte" dev infra "$(overlay voldrv 'volumes: {raijin-pgdata: {driver_opts: {type: none, o: bind, device: /}}}')"
reject "réseau d'un autre projet" dev infra "$(overlay net 'services: {raijin-api: {networks: [mtc]}}
networks: {mtc: {external: true, name: mtc-internal}}')"
reject "réseau interne non préfixé" dev infra "$(overlay netname 'networks: {raijin-internal: {name: autre-reseau}}')"
reject "image étrangère" dev infra "$(overlay img 'services: {raijin-web: {image: "traefik:v3.6"}}')"
reject "image d'un autre environnement" dev infra "$(overlay img2 'services: {raijin-web: {image: "raijin/web:latest"}}')"
reject "conteneur au nom de la prod" dev infra "$(overlay cname 'services: {raijin-web: {container_name: raijin-web}}')"
reject "sans no-new-privileges" dev infra "$(overlay nnp 'services: {raijin-web: {security_opt: !override []}}')"
reject "seccomp désactivé" dev infra "$(overlay seccomp 'services: {raijin-web: {security_opt: ["seccomp=unconfined"]}}')"
reject "env_file de la prod depuis le dev" dev infra "$(overlay envf "services: {raijin-web: {env_file: [\"$work/envdir/prod/.env.api\"]}}")"
reject "secret lu sur le VPS" dev infra "$(overlay sec "services: {raijin-web: {secrets: [s]}}
secrets: {s: {file: /etc/hostname}}")"
reject "env_file relatif hors modèle" dev infra "$(overlay envrel "services: {raijin-web: {env_file: [{path: ../../prod/env/.env.api, required: false}]}}")"

echo "== Archive livrée"
mkdir -p "$work/b"
python3 - "$work/b" <<'PY'
import io, os, sys, tarfile
d = sys.argv[1]
def make(name, members):
    with tarfile.open(os.path.join(d, name), 'w') as t:
        for m in members:
            t.addfile(*m)
def f(n, data=b'x'):
    ti = tarfile.TarInfo(n); ti.size = len(data); return (ti, io.BytesIO(data))
def link(n, target):
    ti = tarfile.TarInfo(n); ti.type = tarfile.SYMTYPE; ti.linkname = target; return (ti,)
make('ok.tar', [f('infra/docker-compose.yml', b'services: {}\n'), f('images.tar.gz')])
make('symlink.tar', [link('infra', '/etc'), f('infra/docker-compose.yml'), f('images.tar.gz')])
make('dotdot.tar', [f('infra/../../evil'), f('images.tar.gz')])
make('abs.tar', [f('/tmp/evil'), f('images.tar.gz')])
make('extra.tar', [f('infra/docker-compose.yml'), f('images.tar.gz'), f('autre/fichier')])
def hard(n, target):
    ti = tarfile.TarInfo(n); ti.type = tarfile.LNKTYPE; ti.linkname = target; return (ti,)
make('hardlink.tar', [f('infra/docker-compose.yml'), f('images.tar.gz'), hard('infra/x', 'infra/docker-compose.yml')])
PY
bundle_case() {
  local want="$1" file="$2" label="$3" dest
  dest="$(mktemp -d -p "$work")"
  if python3 "$policy" bundle "$work/b/$file" "$dest" >"$work/out" 2>&1; then got=ok; else got=refus; fi
  if [[ "$got" == "$want" ]]; then ok "archive $label : $got"; else ko "archive $label : $got au lieu de $want ($(head -n 1 "$work/out"))"; fi
}
bundle_case ok ok.tar "conforme"
bundle_case refus symlink.tar "avec lien symbolique"
bundle_case refus dotdot.tar "avec « .. »"
bundle_case refus abs.tar "avec chemin absolu"
bundle_case refus extra.tar "avec fichier hors infra/"
bundle_case refus hardlink.tar "avec lien physique"

echo "== Étiquettes d'images (docker save)"
sha="$(printf '%040d' 7 | tr 0 a)"
python3 - "$work/b" "$sha" <<'PY'
import gzip, io, json, os, sys, tarfile
d, sha = sys.argv[1], sys.argv[2]
def save(name, tags, annotation=None):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        def add(n, obj):
            data = json.dumps(obj).encode(); ti = tarfile.TarInfo(n); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
        add('manifest.json', [{'Config': 'c.json', 'RepoTags': tags, 'Layers': []}])
        if annotation:
            add('index.json', {'schemaVersion': 2, 'manifests': [{'annotations': {'io.containerd.image.name': annotation}}]})
    with gzip.open(os.path.join(d, name), 'wb') as g:
        g.write(buf.getvalue())
save('img-ok.tar.gz', [f'raijin-dev/api:{sha}', f'raijin-dev/web:{sha}'], f'docker.io/raijin-dev/api:{sha}')
save('img-traefik.tar.gz', [f'raijin-dev/api:{sha}', 'traefik:v3.6'])
save('img-prod.tar.gz', [f'raijin/api:{sha}'])
save('img-latest.tar.gz', ['raijin-dev/api:latest'])
save('img-annot.tar.gz', [f'raijin-dev/api:{sha}'], 'docker.io/library/postgres:17')
PY
image_case() {
  local want="$1" file="$2" label="$3"
  if python3 "$policy" images "$work/b/$file" raijin-dev "$sha" >"$work/out" 2>&1; then got=ok; else got=refus; fi
  if [[ "$got" == "$want" ]]; then ok "images $label : $got"; else ko "images $label : $got au lieu de $want ($(head -n 1 "$work/out"))"; fi
}
image_case ok img-ok.tar.gz "raijin-dev/*:<commit>"
image_case refus img-traefik.tar.gz "avec traefik:v3.6"
image_case refus img-prod.tar.gz "de la prod (raijin/*)"
image_case refus img-latest.tar.gz "« latest » au lieu du commit"
image_case refus img-annot.tar.gz "annotation containerd étrangère"

if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Politique de déploiement : tous les contrôles sont verts."
