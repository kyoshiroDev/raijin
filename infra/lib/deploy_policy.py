#!/usr/bin/env python3
# =====================================================================================================
# Contrôles de infra/deploy-gate.sh (déploiement continu, docs/DEPLOY.md partie C). Copie FIGÉE sur le VPS
# (/opt/raijin-deploy, propriété de root) : une livraison ne peut pas modifier ses propres contrôles.
#
# Pourquoi : quiconque pousse sur `dev` déclenche un déploiement, et l'accès à Docker vaut un accès root sur un VPS
# partagé (MyTradingCoach, XMR Trader). La livraison (images + fichiers Compose) est donc vérifiée AVANT d'être
# chargée ou démarrée :
#   bundle  <archive> <dossier>             archive livrée : fichiers et dossiers ordinaires seulement, aucun chemin
#                                           absolu ni « .. », taille bornée ; extraction dans <dossier> (vide)
#   images  <images.tar.gz> <nom> <sha>     sortie de `docker save` : chaque étiquette est <nom>/<image>:<sha>
#                                           (jamais une image d'un autre projet, comme traefik ou postgres)
#   envfiles <dossier>                      (JSON de `docker compose config --no-interpolate` sur l'entrée) : env_file
#                                           limités aux deux modèles du dépôt (fichiers de l'environnement)
#   compose <nom> <dossier> <réseau> <fichier env…> -- <hôte…>   (JSON de `docker compose config` sur l'entrée)
#                                           pas de privilège, de port publié, de montage hors de la livraison, de
#                                           réseau ou volume d'un autre projet ; routeurs Traefik limités aux noms de
#                                           domaine de l'environnement ; noms préfixés par <nom>-.
# Aucune valeur de variable n'est affichée (le JSON contient des mots de passe) : seuls des noms de clés le sont.
# Python 3.8+ ; bibliothèque standard uniquement.
# =====================================================================================================
import json
import os
import re
import sys
import tarfile

PROJECT_IMAGES = ('api', 'web', 'landing', 'migrate', 'bench-api', 'bench-web', 'bench-migrate')
# Images tierces acceptées : officielles, épinglées par empreinte.
THIRD_PARTY = re.compile(r'^(postgres|redis|axllent/mailpit):[\w.-]+@sha256:[0-9a-f]{64}$')
MAX_BUNDLE_FILE = 4 * 1024 ** 3
MAX_INFRA_FILE = 2 * 1024 ** 2
MIDDLEWARE_TYPES = {'headers', 'ratelimit', 'compress', 'basicauth', 'redirectregex', 'replacepathregex', 'errors',
                    'stripprefix'}
FORBIDDEN_SERVICE_KEYS = ('privileged', 'cap_add', 'devices', 'network_mode', 'pid', 'ipc', 'userns_mode', 'uts',
                          'cgroup', 'cgroup_parent', 'volumes_from', 'ports', 'sysctls', 'device_cgroup_rules',
                          'runtime', 'isolation', 'oom_kill_disable', 'external_links', 'secrets', 'configs',
                          'credential_spec', 'gpus', 'privileged_mode', 'use_api_socket', 'models', 'provider')

errors = []


def fail(msg):
    errors.append(msg)


def finish(what):
    if errors:
        for e in errors:
            print(f'politique {what} : {e}', file=sys.stderr)
        sys.exit(1)
    print(f'politique {what} : conforme')


def safe_name(name):
    name = name[2:] if name.startswith('./') else name
    parts = name.rstrip('/').split('/')
    if not name or name.startswith('/') or '\\' in name or any(p in ('', '.', '..') for p in parts):
        return None
    return '/'.join(parts)


# --- bundle -------------------------------------------------------------------------------------------
def cmd_bundle(archive, dest):
    if os.listdir(dest):
        fail('dossier de destination non vide')
        return finish('bundle')
    with tarfile.open(archive, 'r:') as tar:
        for m in tar:
            name = safe_name(m.name)
            if name is None:
                fail(f'chemin refusé : {m.name[:200]!r}')
                break
            top = name.split('/')[0]
            if not (name == 'images.tar.gz' or top == 'infra'):
                fail(f'fichier inattendu : {name[:200]!r}')
                break
            target = os.path.join(dest, name)
            if m.isdir():
                os.makedirs(target, mode=0o750, exist_ok=True)
            elif m.isfile():
                limit = MAX_BUNDLE_FILE if name == 'images.tar.gz' else MAX_INFRA_FILE
                if m.size > limit:
                    fail(f'fichier trop gros : {name}')
                    break
                os.makedirs(os.path.dirname(target), mode=0o750, exist_ok=True)
                if os.path.lexists(target):
                    fail(f'doublon : {name}')
                    break
                src = tar.extractfile(m)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
                with os.fdopen(fd, 'wb') as out:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
            else:
                # Liens symboliques ou physiques, périphériques, FIFO : jamais.
                fail(f'type de fichier refusé (lien, périphérique…) : {name[:200]!r}')
                break
    for required in ('images.tar.gz', 'infra/docker-compose.yml'):
        if not os.path.isfile(os.path.join(dest, required)):
            fail(f'fichier manquant : {required}')
    finish('bundle')


# --- images -------------------------------------------------------------------------------------------
def cmd_images(archive, name, sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or not re.fullmatch(r'raijin(-dev)?', name):
        fail('nom ou commit invalide')
        return finish('images')
    ref = re.compile(r'^(?:docker\.io/)?(?:library/)?' + re.escape(name) + r'/(' + '|'.join(PROJECT_IMAGES) + r'):' + sha + r'$')
    found = {}
    with tarfile.open(archive, 'r|*') as tar:
        for m in tar:
            if m.name in ('manifest.json', 'index.json', 'repositories') and m.isfile():
                if m.size > MAX_INFRA_FILE:
                    fail(f'{m.name} trop gros')
                    continue
                found[m.name] = json.load(tar.extractfile(m))
    tags = []
    manifest = found.get('manifest.json')
    if not isinstance(manifest, list) or not manifest:
        fail('manifest.json absent ou vide (archive docker save attendue)')
    else:
        for entry in manifest:
            repo_tags = entry.get('RepoTags') or []
            if not repo_tags:
                fail('image sans étiquette')
            tags += repo_tags
    index = found.get('index.json')
    if isinstance(index, dict):
        for desc in index.get('manifests') or []:
            ann = desc.get('annotations') or {}
            image_name = ann.get('io.containerd.image.name')
            if image_name is not None:
                tags.append(image_name)
            ref_name = ann.get('org.opencontainers.image.ref.name')
            if ref_name is not None and ref_name != sha:
                tags.append(ref_name)
    repositories = found.get('repositories')
    if isinstance(repositories, dict):
        for repo, tag_map in repositories.items():
            for tag in (tag_map or {}):
                tags.append(f'{repo}:{tag}')
    for tag in tags:
        if not isinstance(tag, str) or not ref.match(tag):
            fail(f'étiquette refusée : {str(tag)[:120]!r} (attendu {name}/<image>:{sha[:12]}…)')
    finish('images')


# --- compose ------------------------------------------------------------------------------------------
def under(path, root):
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def prefixed(value, name):
    return value.startswith(name + '-') and (name == 'raijin-dev' or not value.startswith('raijin-dev-'))


def check_rule(where, rule, hosts):
    if re.search(r'HostRegexp|HostSNI|HostHeader', rule):
        fail(f'{where} : matcher d\'hôte refusé (HostRegexp, HostSNI…)')
    found = re.findall(r'Host\(([^)]*)\)', rule)
    if not found:
        fail(f'{where} : règle sans Host(…)')
    for group in found:
        for host in re.findall(r'`([^`]*)`', group):
            if host.lower() not in hosts:
                fail(f'{where} : nom de domaine hors de l\'environnement : {host[:80]}')


def check_labels(svc, labels, name, network, hosts):
    for key, value in labels.items():
        if not key.startswith('traefik.'):
            continue
        value = str(value)
        if key.startswith(('traefik.tcp.', 'traefik.udp.', 'traefik.tls.')):
            fail(f'{svc} : label {key} refusé (TCP, UDP, options TLS globales)')
            continue
        if key == 'traefik.docker.network':
            if value != network:
                fail(f'{svc} : traefik.docker.network doit valoir le réseau Traefik configuré')
            continue
        if key in ('traefik.enable',):
            continue
        m = re.match(r'^traefik\.http\.(routers|middlewares|services)\.([^.]+)\.(.+)$', key)
        if not m:
            fail(f'{svc} : label {key[:120]} refusé')
            continue
        kind, obj, rest = m.groups()
        if not prefixed(obj, name):
            fail(f'{svc} : {kind} « {obj} » doit commencer par {name}-')
        if kind == 'routers':
            if rest == 'rule':
                check_rule(f'{svc} routeur {obj}', value, hosts)
            elif rest == 'service':
                if '@' in value or not prefixed(value, name):
                    fail(f'{svc} routeur {obj} : service « {value[:80]} » refusé')
            elif rest == 'middlewares':
                for mw in [v.strip() for v in value.split(',') if v.strip()]:
                    if '@' in mw or not prefixed(mw, name):
                        fail(f'{svc} routeur {obj} : middleware « {mw[:80]} » refusé')
            elif rest.startswith('tls.domains'):
                fail(f'{svc} routeur {obj} : tls.domains refusé (noms tirés de la règle Host)')
        elif kind == 'middlewares':
            mtype = rest.split('.')[0].lower()
            if mtype not in MIDDLEWARE_TYPES:
                fail(f'{svc} middleware {obj} : type « {mtype} » refusé')
            if mtype == 'errors' and rest.lower() == 'errors.service' and ('@' in value or not prefixed(value, name)):
                fail(f'{svc} middleware {obj} : service d\'erreur « {value[:80]} » refusé')
        elif kind == 'services':
            if not re.fullmatch(r'loadbalancer\.(server\.port|server\.scheme|healthcheck\.[a-z]+|passhostheader|responseforwarding\.flushinterval)', rest.lower()):
                fail(f'{svc} service {obj} : option {rest[:80]} refusée (seuls port, scheme et healthcheck)')


def cmd_compose(argv):
    if '--' not in argv:
        fail('usage : compose <nom> <dossier> <réseau> <fichier env…> -- <hôte…>')
        return finish('compose')
    sep = argv.index('--')
    head, hosts = argv[:sep], {h.lower() for h in argv[sep + 1:] if h}
    if len(head) < 3:
        fail('arguments manquants')
        return finish('compose')
    name, root, network, env_files = head[0], os.path.realpath(head[1]), head[2], {os.path.realpath(f) for f in head[3:]}
    if not re.fullmatch(r'raijin(-dev)?', name):
        fail('nom de projet invalide')
        return finish('compose')
    cfg = json.load(sys.stdin)
    for key in cfg:
        if key not in ('name', 'services', 'networks', 'volumes') and not key.startswith('x-'):
            fail(f'section de premier niveau refusée : {key}')
    if cfg.get('name') != name:
        fail(f'nom de projet {cfg.get("name")!r} au lieu de {name!r}')
    networks = cfg.get('networks') or {}
    for key, net in networks.items():
        net_name = net.get('name', '')
        if net.get('external'):
            if net_name != network:
                fail(f'réseau externe « {net_name} » refusé (seul le réseau Traefik configuré)')
        elif not (net.get('internal') and prefixed(net_name, name)):
            fail(f'réseau « {key} » : doit être interne et nommé {name}-…')
        if net.get('driver') or net.get('driver_opts'):
            fail(f'réseau « {key} » : driver / driver_opts refusés')
    volumes = cfg.get('volumes') or {}
    for key, vol in volumes.items():
        if vol.get('external') or not prefixed(vol.get('name', ''), name):
            fail(f'volume « {key} » : doit être propre au projet et nommé {name}-…')
        if vol.get('driver') or vol.get('driver_opts'):
            fail(f'volume « {key} » : driver / driver_opts refusés (montage de l\'hôte possible)')
    project_image = re.compile(r'^' + re.escape(name) + r'/(' + '|'.join(PROJECT_IMAGES) + r'):[\w.-]+$')
    for svc, s in (cfg.get('services') or {}).items():
        for key in FORBIDDEN_SERVICE_KEYS:
            if s.get(key):
                fail(f'{svc} : « {key} » refusé')
        image = s.get('image', '')
        own = bool(project_image.match(image))
        if not own and not THIRD_PARTY.match(image):
            fail(f'{svc} : image « {image[:120]} » refusée')
        cname = s.get('container_name')
        if cname is not None and not prefixed(cname, name):
            fail(f'{svc} : container_name doit commencer par {name}-')
        sec = [str(o) for o in (s.get('security_opt') or [])]
        if not any(o.replace('=', ':') == 'no-new-privileges:true' for o in sec):
            fail(f'{svc} : security_opt no-new-privileges:true obligatoire')
        if any('unconfined' in o or 'disable' in o for o in sec):
            fail(f'{svc} : security_opt « unconfined » / « disable » refusé')
        if own and 'ALL' not in (s.get('cap_drop') or []):
            fail(f'{svc} : cap_drop ALL obligatoire pour les images du projet')
        for v in s.get('volumes') or []:
            vtype = v.get('type')
            if vtype == 'volume':
                if v.get('source') not in volumes:
                    fail(f'{svc} : volume « {v.get("source")} » non déclaré par le projet')
            elif vtype == 'bind':
                if not under(v.get('source', '/'), root) or not v.get('read_only'):
                    fail(f'{svc} : montage de l\'hôte refusé (seulement en lecture seule, dans la livraison)')
            elif vtype != 'tmpfs':
                fail(f'{svc} : volume de type « {vtype} » refusé')
        for net in (s.get('networks') or {}):
            if net not in networks:
                fail(f'{svc} : réseau « {net} » non déclaré')
        for ef in s.get('env_file') or []:
            path = ef.get('path') if isinstance(ef, dict) else ef
            if os.path.realpath(str(path)) not in env_files:
                fail(f'{svc} : env_file hors des fichiers de l\'environnement refusé')
        labels = s.get('labels') or {}
        if isinstance(labels, list):
            labels = dict(item.split('=', 1) if '=' in item else (item, '') for item in labels)
        check_labels(svc, labels, name, network, hosts)
    finish('compose')


# --- envfiles -----------------------------------------------------------------------------------------
# Rendu SANS interpolation (`docker compose config --no-interpolate`) : seul rendu où Compose garde les chemins des
# env_file. Chaque env_file doit être l'un des deux modèles du dépôt, que deploy-gate.sh fait pointer vers les fichiers
# de l'environnement (jamais un fichier de l'autre environnement, ni un fichier quelconque du VPS).
ALLOWED_ENV_FILES = ('${RAIJIN_API_ENV_FILE:-.env.api}', '${RAIJIN_BENCH_API_ENV_FILE:-.env.bench-api}')


def cmd_envfiles(root):
    root = root.rstrip('/')
    cfg = json.load(sys.stdin)
    for svc, s in (cfg.get('services') or {}).items():
        for ef in s.get('env_file') or []:
            path = str(ef.get('path') if isinstance(ef, dict) else ef)
            rel = path[len(root) + 1:] if path.startswith(root + '/') else path
            if rel not in ALLOWED_ENV_FILES:
                fail(f'{svc} : env_file refusé (seuls {" et ".join(ALLOWED_ENV_FILES)})')
    finish('env_file')


def main(argv):
    if len(argv) >= 3 and argv[0] == 'bundle':
        return cmd_bundle(argv[1], argv[2])
    if len(argv) == 4 and argv[0] == 'images':
        return cmd_images(argv[1], argv[2], argv[3])
    if len(argv) == 2 and argv[0] == 'envfiles':
        return cmd_envfiles(argv[1])
    if argv and argv[0] == 'compose':
        return cmd_compose(argv[1:])
    print('usage : deploy_policy.py bundle|images|compose …', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    main(sys.argv[1:])
