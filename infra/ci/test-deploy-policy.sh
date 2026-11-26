#!/usr/bin/env bash
# Contrôles de la porte de déploiement (infra/lib/deploy_policy.py), rendus comme sur le VPS (env -i, fichier de
# l'environnement, configuration résolue) : configurations réelles prod et dev ACCEPTÉES ; livraisons dangereuses
# REFUSÉES (privilège, port, montage de l'hôte ou du socket Docker y compris par interpolation, réseau ou volume d'un
# autre projet, domaine d'un autre site, règle Traefik avec « || » ou casse modifiée, priority, options non listées,
# tableau de bord Traefik, pull_policy, étiquette d'image, build, ressources ou journalisation manquantes,
# extra_hosts / dns, env_file de la prod) ; archive avec lien, « .. », chemin absolu ou .env ; image avec label
# traefik.*, VOLUME ou root ; jeton OIDC (signature, audience, branche, commit, expiration).
# Sans démon Docker (seul `docker compose config` est utilisé). Job « infra » de ci.yml ; aussi en local.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
policy="$PWD/infra/lib/deploy_policy.py"
infra="$PWD/infra"
work="$(mktemp -d)"
trap 'rm -r -- "$work"' EXIT
failures=0
ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '::error::%s\n' "$*"; failures=$((failures + 1)); }
sha="$(printf '%040d' 7 | tr 0 a)"
CLEAN_PATH="$PATH"

fill="remplissage-$(openssl rand -hex 16)"
cat >"$work/prod.env" <<EOF
TRAEFIK_NETWORK=traefik-ci
TRAEFIK_ENTRYPOINT=websecure
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
  -e 's/^API_DOMAIN=.*/API_DOMAIN=api-dev.raijinshield.com/' -e 's/^TRAEFIK_NETWORK=.*/TRAEFIK_NETWORK=raijin-dev-edge/' \
  "$work/prod.env" >"$work/dev.env"
printf "RAIJIN_NAME=raijin-dev\nDEV_BASIC_AUTH_USERS='ci:\$apr1\$remplissage'\n" >>"$work/dev.env"
mkdir -p "$work/envdir/prod" "$work/envdir/dev"
: >"$work/envdir/prod/.env.api"; : >"$work/envdir/prod/.env.bench-api"; : >"$work/envdir/dev/.env.api"
prod_hosts=raijinshield.com,www.raijinshield.com,app.raijinshield.com,api.raijinshield.com,banc.raijinshield.com
dev_hosts=landing-dev.raijinshield.com,dev.raijinshield.com,api-dev.raijinshield.com

# render <env> [--no-interpolate] [fichier supplémentaire…] : comme deploy-gate.sh (env -i, liste blanche).
render() {
  local env="$1" extra_flag=() files=(-f "$infra/docker-compose.yml") name=raijin profiles=(--profile tools --profile bench)
  shift
  [[ "${1:-}" == --no-interpolate ]] && { extra_flag=(--no-interpolate); shift; }
  [[ "$env" == dev ]] && { files+=(-f "$infra/docker-compose.env-dev.yml"); name=raijin-dev; profiles=(--profile tools); }
  for extra in "$@"; do files+=(-f "$extra"); done
  env -i PATH="$CLEAN_PATH" HOME="$HOME" RAIJIN_NAME="$name" RAIJIN_TAG="$sha" \
    RAIJIN_API_ENV_FILE="$work/envdir/$env/.env.api" RAIJIN_BENCH_API_ENV_FILE="$work/envdir/$env/.env.bench-api" \
    docker compose -p "$name" --env-file "$work/$env.env" --project-directory "$infra" "${files[@]}" "${profiles[@]}" \
    config --format json "${extra_flag[@]}"
}
# policy_compose <env> <résolu.json> [hôtes] [réseau]
policy_compose() {
  local env="$1" file="$2" name=raijin hosts="$prod_hosts" net=traefik-ci
  [[ "$env" == dev ]] && { name=raijin-dev hosts="$dev_hosts" net=raijin-dev-edge; }
  python3 "$policy" compose "$file" --name "$name" --root "$infra" --network "${4:-$net}" --entrypoint websecure \
    --certresolver ci --tag "$sha" --hosts "${3:-$hosts}"
}
# judge <env> [overlay…] : envfiles + resolve + compose, comme la porte.
judge() {
  local env="$1"
  shift
  rm -f "$work/raw.json" "$work/res.json"
  # Pré-contrôle des YAML livrés (comme la porte) : fichiers réels, puis chaque surcouche à la place du fichier dev.
  python3 "$policy" yamlcheck "$infra" >"$work/out" 2>&1 || return 1
  local o yd
  for o in "$@"; do
    yd="$(mktemp -d -p "$work")"
    cp "$o" "$yd/docker-compose.env-dev.yml"
    python3 "$policy" yamlcheck "$yd" >"$work/out" 2>&1 || return 1
  done
  render "$env" --no-interpolate "$@" 2>/dev/null | python3 "$policy" envfiles "$infra" >"$work/out" 2>&1 || return 1
  render "$env" "$@" >"$work/raw.json" 2>"$work/out" || return 1
  python3 "$policy" resolve "$work/raw.json" "$work/res.json" >/dev/null
  policy_compose "$env" "$work/res.json" >"$work/out" 2>&1
}
accept() { if judge "$@"; then ok "accepté : $1 (configuration réelle)"; else ko "refusé à tort : $1 $(tr '\n' ' ' <"$work/out" | head -c 400)"; fi; }
reject() {
  local label="$1"; shift
  if judge "$@"; then ko "accepté à tort : $label"; else ok "refusé : $label ($(head -n 1 "$work/out"))"; fi
}
overlay() { printf '%s\n' "$2" >"$work/$1.yml"; echo "$work/$1.yml"; }

echo "== Configurations réelles"
accept prod
accept dev

echo "== Livraisons dangereuses (dev)"
reject "privileged" dev "$(overlay privileged 'services: {raijin-web: {privileged: true}}')"
reject "port publié" dev "$(overlay ports 'services: {raijin-web: {ports: ["8080:8080"]}}')"
reject "montage de / (hôte)" dev "$(overlay bind 'services: {raijin-web: {volumes: ["/:/host:ro"]}}')"
reject "socket Docker" dev "$(overlay sock 'services: {raijin-api: {volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]}}')"
reject "socket Docker par interpolation (variable du fichier d'env)" dev \
  "$(overlay sockvar 'services: {raijin-web: {volumes: [{type: bind, source: "${TRAEFIK_ENTRYPOINT:+/}var/run/docker.sock", target: /s, read_only: true}]}}')"
reject "cap_add" dev "$(overlay capadd 'services: {raijin-api: {cap_add: [SYS_ADMIN]}}')"
reject "network_mode host" dev "$(overlay nethost 'services: {raijin-web: {network_mode: host, networks: !reset null}}')"
reject "extra_hosts" dev "$(overlay xhosts 'services: {raijin-web: {extra_hosts: ["db:10.0.0.1"]}}')"
reject "dns" dev "$(overlay dns 'services: {raijin-web: {dns: [1.1.1.1]}}')"
reject "domaine de la prod depuis le dev" dev "$(overlay hijack 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.rule=Host(`app.raijinshield.com`)"]}}')"
reject "règle avec ||" dev "$(overlay or 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.rule=Host(`dev.raijinshield.com`) || PathPrefix(`/`)"]}}')"
reject "règle avec !" dev "$(overlay not 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.rule=Host(`dev.raijinshield.com`) && !Path(`/x`)"]}}')"
reject "hôte en majuscules" dev "$(overlay case1 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.rule=Host(`APP.RAIJINSHIELD.COM`)"]}}')"
reject "matcher en minuscules (host)" dev "$(overlay case2 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.rule=host(`app.raijinshield.com`)"]}}')"
reject "clé Traefik en majuscules" dev "$(overlay case3 'services: {raijin-web: {labels: ["TRAEFIK.http.routers.raijin-x.rule=Host(`app.raijinshield.com`)"]}}')"
reject "priority 99999" dev "$(overlay prio 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.priority=99999"]}}')"
reject "option de routeur non listée" dev "$(overlay ropt 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.observability.accesslogs=false"]}}')"
reject "domaine d'un autre site" dev "$(overlay mtc 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-x.rule=Host(`mytradingcoach.example`)"]}}')"
reject "HostRegexp" dev "$(overlay regexp 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-x.rule=HostRegexp(`.+`)"]}}')"
reject "tableau de bord Traefik (api@internal)" dev "$(overlay dash 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-dev-web.service=api@internal"]}}')"
reject "routeur au nom de la prod" dev "$(overlay prodname 'services: {raijin-web: {labels: ["traefik.http.routers.raijin-web.rule=Host(`dev.raijinshield.com`)"]}}')"
reject "middleware forwardAuth" dev "$(overlay fwd 'services: {raijin-web: {labels: ["traefik.http.middlewares.raijin-dev-fa.forwardauth.address=http://x"]}}')"
reject "redirection vers un autre site" dev "$(overlay redir 'services: {raijin-web: {labels: ["traefik.http.middlewares.raijin-dev-r.redirectregex.replacement=https://evil.example/"]}}')"
reject "service vers une URL" dev "$(overlay url 'services: {raijin-web: {labels: ["traefik.http.services.raijin-dev-web.loadbalancer.server.url=http://mtc:3000"]}}')"
reject "routeur TCP" dev "$(overlay tcp 'services: {raijin-web: {labels: ["traefik.tcp.routers.raijin-dev-t.rule=HostSNI(`*`)"]}}')"
reject "volume de la prod" dev "$(overlay vol 'volumes: {raijin-pgdata: {name: raijin-pgdata}}')"
reject "volume externe" dev "$(overlay volext 'services: {raijin-web: {volumes: ["x:/data"]}}
volumes: {x: {external: true, name: mtc-data}}')"
reject "volume local monté sur l'hôte" dev "$(overlay voldrv 'volumes: {raijin-pgdata: {driver_opts: {type: none, o: bind, device: /}}}')"
reject "réseau d'un autre projet" dev "$(overlay net 'services: {raijin-api: {networks: [mtc]}}
networks: {mtc: {external: true, name: mtc-internal}}')"
reject "réseau interne non préfixé" dev "$(overlay netname 'networks: {raijin-internal: {name: autre-reseau}}')"
reject "image étrangère" dev "$(overlay img 'services: {raijin-web: {image: "traefik:v3.6"}}')"
reject "image d'un autre environnement" dev "$(overlay img2 "services: {raijin-web: {image: \"raijin/web:$sha\"}}")"
reject "étiquette latest au lieu du commit" dev "$(overlay tag 'services: {raijin-web: {image: "raijin-dev/web:latest"}}')"
reject "pull_policy always" dev "$(overlay pull 'services: {raijin-web: {pull_policy: always}}')"
reject "conteneur au nom de la prod" dev "$(overlay cname 'services: {raijin-web: {container_name: raijin-web}}')"
reject "sans no-new-privileges" dev "$(overlay nnp 'services: {raijin-web: {security_opt: !override []}}')"
reject "seccomp désactivé" dev "$(overlay seccomp 'services: {raijin-web: {security_opt: ["seccomp=unconfined"]}}')"
reject "sans mem_limit" dev "$(overlay mem 'services: {raijin-web: {mem_limit: !reset null, memswap_limit: !reset null}}')"
reject "mem_limit de 8 Go" dev "$(overlay mem8 'services: {raijin-web: {mem_limit: 8g, memswap_limit: 8g}}')"
reject "sans pids_limit" dev "$(overlay pids 'services: {raijin-web: {pids_limit: !reset null}}')"
reject "journalisation syslog" dev "$(overlay logdrv 'services: {raijin-web: {logging: {driver: syslog, options: !reset {}}}}')"
reject "journaux sans plafond" dev "$(overlay logsize 'services: {raijin-web: {logging: {driver: json-file, options: {max-size: 2g}}}}')"
reject "env_file de la prod depuis le dev" dev "$(overlay envf "services: {raijin-web: {env_file: [\"$work/envdir/prod/.env.api\"]}}")"
reject "env_file relatif hors modèle" dev "$(overlay envrel "services: {raijin-web: {env_file: [{path: ../../prod/env/.env.api, required: false}]}}")"
reject "extends vers la config résolue de la prod" dev "$(overlay ext 'services: {raijin-web: {extends: {file: /srv/raijin/prod/current/compose.resolved.json, service: raijin-api}}}')"
reject "include avec env_file de la prod" dev "$(overlay inc 'include: [{path: ./x.yml, env_file: /srv/raijin/prod/env/.env.api}]')"
reject "label_file" dev "$(overlay lf 'services: {raijin-web: {label_file: /srv/raijin/prod/env/.env}}')"
reject "clé extends échappée (\\u0065)" dev "$(overlay extesc 'services:
  raijin-web:
    "ext\u0065nds": {file: /srv/raijin/prod/env/x.yml, service: raijin-api}')"
reject "sans cpus" dev "$(overlay cpus 'services: {raijin-web: {cpus: !reset null}}')"
reject "cpus 4" dev "$(overlay cpus4 'services: {raijin-web: {cpus: 4}}')"
reject "shm_size 2 Go" dev "$(overlay shm 'services: {raijin-postgres: {shm_size: 2g}}')"
reject "regex de redirection modifiée" dev "$(overlay rx 'services: {raijin-landing: {labels: ["traefik.http.middlewares.raijin-dev-www-redirect.redirectregex.regex=^https?://(.*)$"]}}')"
reject "secret lu sur le VPS" dev "$(overlay sec "services: {raijin-web: {secrets: [s]}}
secrets: {s: {file: /etc/hostname}}")"

echo "== Configuration résolue"
judge dev >/dev/null
# Rendu sous env -i : une variable de l'environnement de l'appelant n'est jamais interpolée.
APP_URL=x render dev "$(overlay sockenv 'services: {raijin-web: {volumes: [{type: bind, source: "${APP_URL:+/}var/run/docker.sock", target: /s, read_only: true}]}}')" 2>/dev/null \
  | grep -q '"source": *"/var/run/docker.sock"' && ko "variable de l'appelant interpolée (env -i inopérant)" || ok "variable de l'appelant ignorée (env -i)"
python3 - "$work/res.json" "$work/lone.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c['services']['raijin-web']['environment'] = {'X': '${APP_URL}'}
json.dump(c, open(sys.argv[2], 'w'))
PY
policy_compose dev "$work/lone.json" >"$work/out" 2>&1 && ko "« \$ » non échappé accepté" || ok "refusé : variable non résolue dans la config ($(head -n 1 "$work/out"))"
render dev >"$work/raw2.json" 2>/dev/null
policy_compose dev "$work/raw2.json" >"$work/out" 2>&1 && ko "config avec build acceptée" || ok "refusé : build dans la config livrée"
policy_compose dev "$work/res.json" "app.raijinshield.com,api-dev.raijinshield.com,landing-dev.raijinshield.com" >"$work/out" 2>&1 \
  && ko "dev : nom sans « dev » accepté" || ok "refusé : nom du dev sans « dev. » / « -dev. »"
policy_compose dev "$work/res.json" "" traefik-ci >"$work/out" 2>&1 && ko "dev sur le réseau de la prod accepté" || ok "refusé : dev sur le réseau Traefik de la prod"

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
def link(n, target, kind=tarfile.SYMTYPE):
    ti = tarfile.TarInfo(n); ti.type = kind; ti.linkname = target; return (ti,)
make('ok.tar', [f('infra/docker-compose.yml', b'services: {}\n'), f('images.tar.gz')])
make('symlink.tar', [link('infra', '/etc'), f('infra/docker-compose.yml'), f('images.tar.gz')])
make('dotdot.tar', [f('infra/../../evil'), f('images.tar.gz')])
make('abs.tar', [f('/tmp/evil'), f('images.tar.gz')])
make('extra.tar', [f('infra/docker-compose.yml'), f('images.tar.gz'), f('autre/fichier')])
make('hardlink.tar', [f('infra/docker-compose.yml'), f('images.tar.gz'), link('infra/x', 'infra/docker-compose.yml', tarfile.LNKTYPE)])
make('dotenv.tar', [f('infra/docker-compose.yml'), f('infra/.env', b'COMPOSE_PROFILES=bench\n'), f('images.tar.gz')])
PY
bundle_case() {
  local want="$1" file="$2" label="$3" dest got
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
bundle_case refus dotenv.tar "avec fichier .env"

echo "== Images (docker save : étiquettes, structure, configuration)"
python3 - "$work/b" "$sha" <<'PY'
import gzip, hashlib, io, json, os, sys, tarfile
d, sha = sys.argv[1], sys.argv[2]
def save(name, tags, labels=None, volumes=None, user='node', extra=None, oci=None, cfg_size=None, manifest_size=None, skip_cfg=False):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        def add(n, obj=None, raw=None):
            data = raw if raw is not None else json.dumps(obj).encode()
            ti = tarfile.TarInfo(n); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
        cfg = json.dumps({'config': {'Labels': labels or {}, 'Volumes': volumes, 'User': user}}).encode()
        if cfg_size:
            cfg += b' ' * cfg_size
        cdig = hashlib.sha256(cfg).hexdigest()
        if not skip_cfg:
            add(f'blobs/sha256/{cdig}', raw=cfg)
        if oci is not None:
            # index.json → manifeste OCI → config (éventuellement une AUTRE config que celle de manifest.json)
            ocfg = json.dumps({'config': {'Labels': oci, 'User': 'node'}}).encode()
            odig = hashlib.sha256(ocfg).hexdigest()
            add(f'blobs/sha256/{odig}', raw=ocfg)
            man = json.dumps({'schemaVersion': 2, 'config': {'digest': f'sha256:{odig}'}, 'layers': []}).encode()
            mdig = hashlib.sha256(man).hexdigest()
            add(f'blobs/sha256/{mdig}', raw=man)
            add('index.json', {'schemaVersion': 2, 'manifests': [{'digest': f'sha256:{mdig}', 'annotations': {'io.containerd.image.name': f'docker.io/{tags[0]}'}}]})
        for e in (extra or []):
            e(t, add)
        m = [{'Config': f'blobs/sha256/{cdig}', 'RepoTags': tags, 'Layers': []}]
        if manifest_size:
            add('manifest.json', raw=json.dumps(m).encode() + b' ' * manifest_size)
        else:
            add('manifest.json', m)
    with gzip.open(os.path.join(d, name), 'wb') as g:
        g.write(buf.getvalue())
ok = [f'raijin-dev/api:{sha}', f'raijin-dev/web:{sha}']
save('img-ok.tar.gz', ok, labels={'org.opencontainers.image.title': 'x', 'com.docker.compose.project': 'raijin-dev'}, oci={})
save('img-traefik.tar.gz', [f'raijin-dev/api:{sha}', 'traefik:v3.6'])
save('img-prod.tar.gz', [f'raijin/api:{sha}'])
save('img-latest.tar.gz', ['raijin-dev/api:latest'])
save('img-label.tar.gz', ok, labels={'traefik.http.routers.raijin-dev-x.rule': 'Host(`app.raijinshield.com`)'})
save('img-label-case.tar.gz', ok, labels={'Traefik.Enable': 'true'})
save('img-volume.tar.gz', ok, volumes={'/data': {}})
save('img-root.tar.gz', ok, user='')
save('img-oci-label.tar.gz', ok, oci={'traefik.enable': 'true'})
save('img-big-config.tar.gz', ok, cfg_size=3 * 1024 * 1024)   # > 2 Mio : lue quand même (plus de budget)
save('img-huge-manifest.tar.gz', ok, manifest_size=5 * 1024 * 1024)
save('img-no-config.tar.gz', ok, skip_cfg=True)
def pad_then_second_manifest(t, add):
    for i in range(40):
        add(f'blobs/sha256/{i:064x}', raw=b'x' * (2 * 1024 * 1024 + 1))
    add('manifest.json', [{'Config': 'blobs/sha256/x', 'RepoTags': ['traefik:v3.6'], 'Layers': []}])
save('img-dup-manifest.tar.gz', ok, extra=[pad_then_second_manifest])
def hardlink(t, add):
    ti = tarfile.TarInfo('repositories'); ti.type = tarfile.LNKTYPE; ti.linkname = 'manifest.json'; t.addfile(ti)
save('img-hardlink.tar.gz', ok, extra=[hardlink])
def symlink(t, add):
    ti = tarfile.TarInfo('blobs/sha256/lien'); ti.type = tarfile.SYMTYPE; ti.linkname = '/etc/shadow'; t.addfile(ti)
save('img-symlink.tar.gz', ok, extra=[symlink])
PY
image_case() {
  local want="$1" file="$2" label="$3" got
  if python3 "$policy" images "$work/b/$file" raijin-dev "$sha" "$work/expected" >"$work/out" 2>&1; then got=ok; else got=refus; fi
  if [[ "$got" == "$want" ]]; then ok "images $label : $got"; else ko "images $label : $got au lieu de $want ($(head -n 1 "$work/out"))"; fi
}
image_case ok img-ok.tar.gz "raijin-dev/*:<commit> (index OCI suivi)"
image_case refus img-traefik.tar.gz "avec traefik:v3.6"
image_case refus img-prod.tar.gz "de la prod (raijin/*)"
image_case refus img-latest.tar.gz "« latest » au lieu du commit"
image_case refus img-label.tar.gz "avec LABEL traefik.* (routeur caché dans l'image)"
image_case refus img-label-case.tar.gz "avec LABEL Traefik.* (casse)"
image_case refus img-volume.tar.gz "avec VOLUME"
image_case refus img-root.tar.gz "sans USER (root)"
image_case refus img-oci-label.tar.gz "config de l'index OCI avec label traefik.*"
image_case ok img-big-config.tar.gz "config de 3 Mio lue en entier"
image_case refus img-huge-manifest.tar.gz "manifest.json au-delà du plafond"
image_case refus img-no-config.tar.gz "Config référencée absente"
image_case refus img-dup-manifest.tar.gz "2e manifest.json après 80 Mio de remplissage"
image_case refus img-hardlink.tar.gz "lien physique dans l'archive"
image_case refus img-symlink.tar.gz "lien symbolique dans l'archive"
python3 "$policy" images "$work/b/img-ok.tar.gz" raijin-dev "$sha" "$work/expected" >/dev/null
printf 'Loaded image: raijin-dev/api:%s\nLoaded image: raijin-dev/web:%s\n' "$sha" "$sha" | python3 "$policy" loaded "$work/expected" >/dev/null \
  && ok "docker load : sortie conforme acceptée" || ko "docker load : sortie conforme refusée"
printf 'Loaded image: raijin-dev/api:%s\nLoaded image: traefik:v3.6\n' "$sha" | python3 "$policy" loaded "$work/expected" >/dev/null 2>&1 \
  && ko "docker load : étiquette en trop acceptée" || ok "docker load : étiquette en trop refusée"
printf 'Loaded image ID: sha256:%064d\n' 0 | python3 "$policy" loaded "$work/expected" >/dev/null 2>&1 \
  && ko "docker load : image sans étiquette acceptée" || ok "docker load : image sans étiquette refusée"

echo "== Jeton OIDC (clé RSA de test, jamais celle de GitHub)"
openssl genrsa -out "$work/k.pem" 2048 2>/dev/null
openssl genrsa -out "$work/k2.pem" 2048 2>/dev/null
python3 - "$work" <<'PY'
import base64, json, subprocess, sys
w = sys.argv[1]
mod = subprocess.check_output(['openssl', 'rsa', '-in', f'{w}/k.pem', '-noout', '-modulus'], text=True).strip().split('=')[1]
n = bytes.fromhex(mod)
u = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
json.dump({'keys': [{'kty': 'RSA', 'kid': 'ci', 'n': u(n), 'e': u((65537).to_bytes(3, 'big'))}]}, open(f'{w}/jwks.json', 'w'))
PY
# jwt <fichier clé> <revendications JSON>
jwt() {
  local h p s
  h="$(printf '{"alg":"RS256","kid":"ci","typ":"JWT"}' | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  p="$(printf '%s' "$2" | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  s="$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$1" -binary | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  printf '%s.%s.%s' "$h" "$p" "$s"
}
now="$(date +%s)"
claims() {  # claims <aud> <workflow_ref> <sha> <exp>
  printf '{"iss":"https://token.actions.githubusercontent.com","aud":"%s","repository":"ci/raijin","ref":"refs/heads/main","workflow_ref":"%s","sha":"%s","exp":%s,"iat":%s,"run_id":"1"}' \
    "$1" "$2" "$3" "$4" "$now"
}
good_ref="ci/raijin/.github/workflows/deploy.yml@refs/heads/main"
oidc_case() {
  local want="$1" token="$2" label="$3" got
  if python3 "$policy" oidc "$token" --jwks "$work/jwks.json" --aud "raijin-depot-prod:abc" --repo ci/raijin --sha "$sha" >"$work/out" 2>&1; then got=ok; else got=refus; fi
  if [[ "$got" == "$want" ]]; then ok "oidc $label : $got"; else ko "oidc $label : $got au lieu de $want ($(tail -n 1 "$work/out"))"; fi
}
oidc_case ok "$(jwt "$work/k.pem" "$(claims raijin-depot-prod:abc "$good_ref" "$sha" $((now + 300)))")" "jeton conforme"
oidc_case refus "$(jwt "$work/k2.pem" "$(claims raijin-depot-prod:abc "$good_ref" "$sha" $((now + 300)))")" "signé par une autre clé"
oidc_case refus "$(jwt "$work/k.pem" "$(claims raijin-depot-prod:autre "$good_ref" "$sha" $((now + 300)))")" "autre archive (audience)"
oidc_case refus "$(jwt "$work/k.pem" "$(claims raijin-depot-prod:abc "ci/raijin/.github/workflows/deploy.yml@refs/heads/dev" "$sha" $((now + 300)))")" "workflow de la branche dev"
oidc_case refus "$(jwt "$work/k.pem" "$(claims raijin-depot-prod:abc "$good_ref" "$(printf '%040d' 1)" $((now + 300)))")" "autre commit"
oidc_case refus "$(jwt "$work/k.pem" "$(claims raijin-depot-prod:abc "$good_ref" "$sha" $((now - 3600)))")" "expiré"

if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Politique de déploiement : tous les contrôles sont verts."
