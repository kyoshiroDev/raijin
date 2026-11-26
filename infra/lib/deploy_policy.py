#!/usr/bin/env python3
# =====================================================================================================
# Contrôles du déploiement continu (infra/deploy-gate.sh, infra/release.sh, docs/DEPLOY.md partie C). Copie FIGÉE sur
# le VPS (/opt/raijin-deploy, propriété de root) : une livraison ne peut pas modifier ses propres contrôles.
#
# Pourquoi : l'accès à Docker vaut un accès root sur un VPS partagé (MyTradingCoach, XMR Trader). Tout ce qui vient de
# GitHub (images, fichiers Compose) est vérifié AVANT d'être chargé ou démarré, et la configuration effectivement
# démarrée est UNE configuration résolue (aucune interpolation ultérieure), contrôlée juste avant chaque up / run.
#
#   bundle   <archive> <dossier>          archive livrée : fichiers ordinaires seulement, aucun chemin absolu, « .. »,
#                                         lien ni fichier .env ; taille bornée ; extraction dans <dossier> (vide)
#   images   <images.tar.gz> <nom> <sha>  sortie de `docker save` : étiquettes <nom>/<image>:<sha> uniquement ;
#                                         configuration de chaque image : aucun label traefik.*,
#                                         aucun VOLUME, utilisateur non root
#   yamlcheck <dossier infra>             AVANT tout rendu : aucun include / extends / label_file, env_file limités
#                                         aux deux modèles (Compose lirait sinon des fichiers d'un autre environnement)
#   envfiles <dossier>                    (JSON `docker compose config --no-interpolate` sur l'entrée) : env_file
#                                         limités aux deux modèles du dépôt
#   resolve  <brut.json> <résolu.json>    retire build et x-* du rendu (la config livrée ne construit jamais rien)
#   compose  <résolu.json> --name … --root … --network … --entrypoint … --certresolver … --tag … --hosts a,b
#                                         politique complète de la configuration résolue
#   thirdparty <résolu.json>              images tierces (épinglées par empreinte) à télécharger avant `--pull never`
#   oidc     <jeton> --jwks f --aud a --repo r --sha s
#                                         jeton OIDC GitHub Actions (RS256) : émis pour .github/workflows/deploy.yml
#                                         sur refs/heads/main, au commit s, pour l'empreinte de l'archive (audience)
# Les messages ne contiennent que des noms (services, clés), jamais de valeur (le JSON contient des mots de passe).
# Python 3.8+ ; bibliothèque standard uniquement.
# =====================================================================================================
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import tarfile
import time

PROJECT_IMAGES = ('api', 'web', 'landing', 'migrate', 'bench-api', 'bench-web', 'bench-migrate')
THIRD_PARTY = re.compile(r'^(postgres|redis|axllent/mailpit):[\w.-]+@sha256:[0-9a-f]{64}$')
MAX_BUNDLE_FILE = 4 * 1024 ** 3
MAX_INFRA_FILE = 2 * 1024 ** 2
MAX_MEM = 1024 ** 3
MAX_PIDS = 500
MAX_LOG_SIZE = 50 * 1024 ** 2
MAX_LOG_FILES = 5
MAX_PRIORITY = 1000

# Liste blanche des clés de service (tout le reste est refusé : build, ports, privileged, cap_add, devices,
# network_mode, pid, ipc, extra_hosts, dns, dns_search, mac_address, sysctls, volumes_from, secrets, configs…).
ALLOWED_SERVICE_KEYS = {
    'image', 'container_name', 'restart', 'environment', 'command', 'entrypoint', 'healthcheck', 'networks', 'volumes',
    'tmpfs', 'read_only', 'depends_on', 'labels', 'mem_limit', 'memswap_limit', 'cpus', 'pids_limit', 'security_opt',
    'cap_drop', 'init', 'logging', 'shm_size', 'stop_grace_period', 'user', 'profiles', 'working_dir', 'pull_policy',
    'stop_signal',
}
# Rappel explicite (messages plus clairs) : jamais autorisées.
FORBIDDEN_SERVICE_KEYS = ('build', 'privileged', 'cap_add', 'devices', 'network_mode', 'pid', 'ipc', 'userns_mode',
                          'uts', 'cgroup', 'cgroup_parent', 'volumes_from', 'ports', 'expose', 'sysctls',
                          'device_cgroup_rules', 'runtime', 'isolation', 'oom_kill_disable', 'external_links', 'links',
                          'secrets', 'configs', 'credential_spec', 'gpus', 'use_api_socket', 'models', 'provider',
                          'extra_hosts', 'dns', 'dns_search', 'dns_opt', 'mac_address', 'env_file', 'develop',
                          'storage_opt', 'blkio_config', 'annotations', 'attach', 'domainname', 'hostname')
LOG_DRIVERS = {'json-file', 'local'}

# Options Traefik autorisées (clés en minuscules).
ROUTER_OPTIONS = {'rule', 'priority', 'entrypoints', 'tls', 'tls.certresolver', 'service', 'middlewares'}
MIDDLEWARE_OPTIONS = {
    'headers': {'stsseconds', 'stsincludesubdomains', 'stspreload', 'contenttypenosniff', 'framedeny',
                'referrerpolicy', 'permissionspolicy', 'contentsecuritypolicy'},
    'ratelimit': {'average', 'period', 'burst'},
    'compress': {'', 'excludedcontenttypes'},
    'basicauth': {'users', 'removeheader', 'realm'},
    'redirectregex': {'regex', 'replacement', 'permanent'},
    'replacepathregex': {'regex', 'replacement'},
    'errors': {'status', 'service', 'query'},
}
SERVICE_OPTIONS = {'loadbalancer.server.port', 'loadbalancer.healthcheck.path', 'loadbalancer.healthcheck.interval'}
# Seule redirection autorisée : www.<landing> → https://<landing>/… (même nom, sans www).
WWW_REDIRECT_REPLACEMENT = 'https://${1}/${2}'
WWW_REDIRECT_REGEX = r'^https?://www\.([^/:]+)(?::\d+)?/(.*)$'
MAX_CPUS = 1.0
MAX_SHM = 256 * 1024 ** 2
# Fichiers Compose livrés lus par la porte, et clés qui y feraient lire d'AUTRES fichiers (secrets d'un autre
# environnement) : refusées avant tout rendu.
COMPOSE_FILES = ('docker-compose.yml', 'docker-compose.env-dev.yml')
FILE_KEYS = ('include', 'extends', 'label_file', 'env_file')
RULE_RE = re.compile(r'^Host\(`([a-z0-9.-]+)`\)((?:\s*&&\s*(?:Path|PathPrefix)\(`/[A-Za-z0-9_./-]*`\))*)$')
DEV_HOST_RE = re.compile(r'^(dev|[a-z0-9-]+-dev)\.[a-z0-9.-]+$')

errors = []


def fail(msg):
    errors.append(msg)


def finish(what):
    if errors:
        for e in errors[:50]:
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
                fail('chemin refusé (absolu, « .. » ou vide)')
                break
            top = name.split('/')[0]
            if not (name == 'images.tar.gz' or top == 'infra'):
                fail('fichier hors de infra/ et images.tar.gz')
                break
            if os.path.basename(name).startswith('.env'):
                fail('fichier .env dans la livraison')
                break
            target = os.path.join(dest, name)
            # infra/ = contenu du dépôt, sans secret, monté en lecture seule dans des conteneurs non root (scripts
            # d'init de Postgres) : lisible par tous, indépendamment de l'umask de la porte (027).
            public = top == 'infra'
            if m.isdir():
                os.makedirs(target, mode=0o750, exist_ok=True)
                os.chmod(target, 0o755 if public else 0o750)
            elif m.isfile():
                limit = MAX_BUNDLE_FILE if name == 'images.tar.gz' else MAX_INFRA_FILE
                if m.size > limit:
                    fail('fichier trop gros')
                    break
                parent = os.path.dirname(target)
                if not os.path.isdir(parent):
                    os.makedirs(parent, mode=0o750, exist_ok=True)
                    if public:
                        os.chmod(parent, 0o755)
                if os.path.lexists(target):
                    fail('doublon dans l\'archive')
                    break
                src = tar.extractfile(m)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
                os.fchmod(fd, 0o644 if public else 0o640)
                with os.fdopen(fd, 'wb') as out:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
            else:
                fail('type de fichier refusé (lien, périphérique…)')
                break
    if not errors and os.path.isdir(os.path.join(dest, 'infra')):
        for d, dirs, files in os.walk(os.path.join(dest, 'infra')):
            os.chmod(d, 0o755)
            for f in files:
                os.chmod(os.path.join(d, f), 0o644)
    for required in ('images.tar.gz', 'infra/docker-compose.yml'):
        if not os.path.isfile(os.path.join(dest, required)):
            fail(f'fichier manquant : {required}')
    finish('bundle')


# --- images -------------------------------------------------------------------------------------------
def check_image_config(ref, cfg):
    c = (cfg or {}).get('config') or {}
    for key in (c.get('Labels') or {}):
        k = str(key).lower()
        # traefik.* : lu par Traefik sur le conteneur (routeur caché dans l'image). com.docker.compose.* (posés par
        # `docker compose build`) : sans effet, Compose les remplace sur le conteneur.
        if k.startswith('traefik'):
            fail(f'{ref} : label d\'image interdit (traefik.*)')
    if c.get('Volumes'):
        fail(f'{ref} : VOLUME déclaré dans l\'image')
    user = str(c.get('User') or '').split(':')[0]
    if user in ('', 'root', '0'):
        fail(f'{ref} : l\'image doit tourner avec un utilisateur non root (USER)')


def cmd_images(archive, name, sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or not re.fullmatch(r'raijin(-dev)?', name):
        fail('nom ou commit invalide')
        return finish('images')
    ref = re.compile(r'^(?:docker\.io/)?' + re.escape(name) + r'/(' + '|'.join(PROJECT_IMAGES) + r'):' + sha + r'$')
    small = {}
    budget = 64 * 1024 ** 2
    with tarfile.open(archive, 'r|*') as tar:
        for m in tar:
            if not m.isfile() or m.size > MAX_INFRA_FILE or budget - m.size < 0:
                continue
            data = tar.extractfile(m).read()
            budget -= len(data)
            small[safe_name(m.name) or m.name] = data

    def load(path):
        try:
            return json.loads(small[path])
        except (KeyError, ValueError):
            return None

    tags = []
    manifest = load('manifest.json')
    if not isinstance(manifest, list) or not manifest:
        fail('manifest.json absent ou vide (archive docker save attendue)')
    else:
        for entry in manifest:
            repo_tags = entry.get('RepoTags') or []
            if not repo_tags:
                fail('image sans étiquette')
            tags += repo_tags
            cfg = load(safe_name(str(entry.get('Config', ''))) or '')
            if cfg is None:
                fail('configuration d\'image illisible')
            else:
                check_image_config(','.join(str(t) for t in repo_tags) or '?', cfg)
    index = load('index.json')
    if isinstance(index, dict):
        for desc in index.get('manifests') or []:
            ann = desc.get('annotations') or {}
            image_name = ann.get('io.containerd.image.name')
            if image_name is not None:
                tags.append(image_name)
            ref_name = ann.get('org.opencontainers.image.ref.name')
            if ref_name is not None and ref_name != sha:
                tags.append(ref_name)
    repositories = load('repositories')
    if isinstance(repositories, dict):
        for repo, tag_map in repositories.items():
            for tag in (tag_map or {}):
                tags.append(f'{repo}:{tag}')
    for tag in tags:
        if not isinstance(tag, str) or not ref.match(tag):
            fail(f'étiquette refusée (attendu {name}/<image>:<commit livré>)')
    finish('images')


# --- envfiles -----------------------------------------------------------------------------------------
ALLOWED_ENV_FILES = ('${RAIJIN_API_ENV_FILE:-.env.api}', '${RAIJIN_BENCH_API_ENV_FILE:-.env.bench-api}')


def cmd_envfiles(root):
    root = root.rstrip('/')
    cfg = json.load(sys.stdin)
    for svc, s in (cfg.get('services') or {}).items():
        for ef in s.get('env_file') or []:
            path = str(ef.get('path') if isinstance(ef, dict) else ef)
            rel = path[len(root) + 1:] if path.startswith(root + '/') else path
            if rel not in ALLOWED_ENV_FILES:
                fail(f'{svc} : env_file refusé (seuls les deux modèles du dépôt)')
    finish('env_file')


# --- yamlcheck ----------------------------------------------------------------------------------------
# AVANT tout rendu : `docker compose config` suit include / extends / env_file / label_file et lirait d'autres
# fichiers (ceux d'un autre environnement) sans laisser de trace dans la configuration résolue. Refusés, sauf les deux
# env_file modèles du dépôt. Double contrôle : lecture YAML exacte (PyYAML, obligatoire : clés échappées ou entre
# guillemets comprises) et recherche textuelle des clés.
def _walk(node, path, where):
    if isinstance(node, dict):
        for k, v in node.items():
            key = str(k)
            if key in ('include', 'extends', 'label_file'):
                fail(f'{where} : clé « {key} » refusée ({path or "racine"})')
            if key == 'env_file':
                items = v if isinstance(v, list) else [v]
                for it in items:
                    pth = it.get('path') if isinstance(it, dict) else it
                    if str(pth) not in ALLOWED_ENV_FILES:
                        fail(f'{where} : env_file hors des deux modèles du dépôt ({path})')
            _walk(v, f'{path}.{key}' if path else key, where)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk(v, f'{path}[{i}]', where)


def cmd_yamlcheck(directory):
    names = sorted(os.listdir(directory))
    for n in names:
        if re.search(r'\.(ya?ml|json)$', n) and n.startswith(('docker-compose', 'compose')) and n not in COMPOSE_FILES:
            fail(f'fichier Compose inattendu : {n[:60]}')
    for n in COMPOSE_FILES:
        path = os.path.join(directory, n)
        if not os.path.isfile(path):
            continue
        text = open(path, encoding='utf-8').read()
        for no, line in enumerate(text.split('\n'), 1):
            code = line.split(' #', 1)[0] if not line.lstrip().startswith('#') else ''
            if re.search(r'(^|[\s{,\[])["\']?(include|extends|label_file)["\']?\s*:', code):
                fail(f'{n}:{no} : clé include / extends / label_file refusée')
            if re.search(r'["\']?env_file["\']?\s*:', code) and n != 'docker-compose.yml':
                fail(f'{n}:{no} : env_file refusé hors du fichier principal')
        try:
            import yaml  # noqa: PLC0415 (paquet python3-yaml, obligatoire : docs/DEPLOY.md C1)
        except ImportError:
            fail('PyYAML absent (sudo apt install python3-yaml) : lecture exacte des fichiers Compose impossible')
            break

        class Loader(yaml.SafeLoader):
            pass

        def any_tag(loader, suffix, node):
            if isinstance(node, yaml.MappingNode):
                return loader.construct_mapping(node, deep=True)
            if isinstance(node, yaml.SequenceNode):
                return loader.construct_sequence(node, deep=True)
            return loader.construct_scalar(node)

        Loader.add_multi_constructor('!', any_tag)
        try:
            for doc in yaml.load_all(text, Loader=Loader):
                _walk(doc, '', n)
        except yaml.YAMLError:
            fail(f'{n} : YAML illisible')
    finish('yaml')


# --- resolve ------------------------------------------------------------------------------------------
def cmd_resolve(src, dst):
    cfg = json.load(open(src))
    for key in [k for k in cfg if k.startswith('x-')]:
        del cfg[key]
    for s in (cfg.get('services') or {}).values():
        s.pop('build', None)
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(cfg, out, indent=1, sort_keys=True)
    print('configuration résolue écrite')


# --- compose ------------------------------------------------------------------------------------------
def size_bytes(value):
    m = re.fullmatch(r'\s*(\d+)\s*([kmgb]?)b?\s*', str(value).lower())
    if not m:
        return None
    return int(m.group(1)) * {'': 1, 'b': 1, 'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3}[m.group(2)]


def under(path, root):
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def prefixed(value, name):
    v = str(value).lower()
    return v.startswith(name + '-') and (name == 'raijin-dev' or not v.startswith('raijin-dev-'))


def check_labels(svc, labels, a):
    for key, value in labels.items():
        # La configuration résolue échappe « $ » en « $$ » (relue par Compose) : valeur réelle comparée.
        k, v = str(key).lower(), str(value).replace('$$', '$')
        if k.startswith('com.docker.'):
            fail(f'{svc} : label {k} réservé à Docker')
            continue
        if not k.startswith('traefik'):
            continue
        if k == 'traefik.enable':
            if v.lower() not in ('true', 'false'):
                fail(f'{svc} : traefik.enable invalide')
            continue
        if k == 'traefik.docker.network':
            if v != a.network:
                fail(f'{svc} : traefik.docker.network doit être le réseau d\'entrée de l\'environnement')
            continue
        m = re.match(r'^traefik\.http\.(routers|middlewares|services)\.([^.]+)\.(.+)$', k)
        if not m:
            fail(f'{svc} : label {k[:120]} refusé (seuls traefik.enable, traefik.docker.network, routeurs, middlewares, services HTTP)')
            continue
        kind, obj, rest = m.groups()
        if not prefixed(obj, a.name):
            fail(f'{svc} : {kind} {obj[:60]} doit commencer par {a.name}-')
        if kind == 'routers':
            if rest not in ROUTER_OPTIONS:
                fail(f'{svc} : option de routeur refusée ({k[:120]})')
            elif rest == 'rule':
                rm = RULE_RE.fullmatch(v)
                if not rm:
                    fail(f'{svc} : règle du routeur {obj} refusée (forme stricte Host(`nom`) [&& Path|PathPrefix(`/…`)]…, sans || ni !)')
                elif rm.group(1) not in a.hosts:
                    fail(f'{svc} : routeur {obj} : nom de domaine hors de l\'environnement')
            elif rest == 'priority':
                if not re.fullmatch(r'\d{1,4}', v) or int(v) > MAX_PRIORITY:
                    fail(f'{svc} : routeur {obj} : priority entière ≤ {MAX_PRIORITY} exigée')
            elif rest == 'entrypoints':
                if v != a.entrypoint:
                    fail(f'{svc} : routeur {obj} : entrypoint différent de celui de l\'environnement')
            elif rest == 'tls':
                if v.lower() != 'true':
                    fail(f'{svc} : routeur {obj} : tls=true exigé')
            elif rest == 'tls.certresolver':
                if v != a.certresolver:
                    fail(f'{svc} : routeur {obj} : certresolver différent de celui de l\'environnement')
            elif rest == 'service':
                if '@' in v or not prefixed(v, a.name):
                    fail(f'{svc} : routeur {obj} : service refusé (autre fournisseur ou autre projet)')
            elif rest == 'middlewares':
                for mw in [x.strip() for x in v.split(',') if x.strip()]:
                    if '@' in mw or not prefixed(mw, a.name):
                        fail(f'{svc} : routeur {obj} : middleware refusé (autre fournisseur ou autre projet)')
        elif kind == 'middlewares':
            mtype, _, opt = rest.partition('.')
            allowed = MIDDLEWARE_OPTIONS.get(mtype)
            if allowed is None:
                fail(f'{svc} : middleware {obj} : type {mtype[:40]} refusé')
                continue
            if mtype == 'headers' and (opt.startswith('customresponseheaders.') or opt == 'customrequestheaders.x-raijin-robots'):
                continue
            if opt not in allowed:
                fail(f'{svc} : middleware {obj} : option {rest[:80]} refusée')
            elif mtype == 'redirectregex' and opt == 'regex' and v != WWW_REDIRECT_REGEX:
                fail(f'{svc} : middleware {obj} : expression de redirection différente de celle de www refusée')
            elif mtype == 'redirectregex' and opt == 'replacement' and v != WWW_REDIRECT_REPLACEMENT:
                fail(f'{svc} : middleware {obj} : redirection vers un autre nom refusée')
            elif mtype == 'replacepathregex' and opt == 'replacement' and not v.startswith('/'):
                fail(f'{svc} : middleware {obj} : réécriture hors chemin local refusée')
            elif mtype == 'errors' and opt == 'service' and ('@' in v or not prefixed(v, a.name)):
                fail(f'{svc} : middleware {obj} : service d\'erreur refusé')
            elif mtype == 'errors' and opt == 'query' and not v.startswith('/'):
                fail(f'{svc} : middleware {obj} : page d\'erreur hors chemin local refusée')
        elif kind == 'services':
            if rest not in SERVICE_OPTIONS:
                fail(f'{svc} : service {obj} : option {rest[:80]} refusée (seuls port et healthcheck)')
            elif rest == 'loadbalancer.server.port' and not re.fullmatch(r'\d{2,5}', v):
                fail(f'{svc} : service {obj} : port invalide')
            elif rest == 'loadbalancer.healthcheck.path' and not v.startswith('/'):
                fail(f'{svc} : service {obj} : chemin de santé invalide')


def cmd_compose(argv):
    p = argparse.ArgumentParser(prog='deploy_policy.py compose')
    p.add_argument('config')
    for opt in ('--name', '--root', '--network', '--entrypoint', '--certresolver', '--tag', '--hosts'):
        p.add_argument(opt, required=True)
    a = p.parse_args(argv)
    a.root = os.path.realpath(a.root)
    a.hosts = {h.strip().lower() for h in a.hosts.split(',') if h.strip()}
    name = a.name
    if not re.fullmatch(r'raijin(-dev)?', name):
        fail('nom de projet invalide')
        return finish('compose')
    if not re.fullmatch(r'[0-9a-f]{40}|deployed', a.tag):
        fail('étiquette attendue : commit complet')
        return finish('compose')
    if name == 'raijin-dev':
        for h in a.hosts:
            if not DEV_HOST_RE.match(h):
                fail('nom de domaine du dev sans « dev. » ni « -dev. »')
        if not prefixed(a.network, name):
            fail('réseau d\'entrée du dev : raijin-dev-… exigé (docs/DEPLOY.md C2)')
    elif a.network.lower().startswith('raijin-dev-'):
        fail('la production ne peut pas utiliser le réseau d\'entrée du dev')
    raw = open(a.config).read()
    # Aucune interpolation possible au démarrage : chaque « $ » de la configuration résolue doit être échappé (« $$ »).
    if '$' in raw.replace('$$', ''):
        fail('variable non résolue dans la configuration (« $ » seul)')
    cfg = json.loads(raw)
    for key in cfg:
        if key not in ('name', 'services', 'networks', 'volumes'):
            fail(f'section de premier niveau refusée : {key[:40]}')
    if cfg.get('name') != name:
        fail('nom de projet différent de celui de l\'environnement')
    networks = cfg.get('networks') or {}
    for key, net in networks.items():
        net_name = str(net.get('name', ''))
        if net.get('external'):
            if net_name != a.network:
                fail(f'réseau externe {key[:40]} refusé (seul le réseau d\'entrée de l\'environnement)')
        elif not (net.get('internal') and prefixed(net_name, name)):
            fail(f'réseau {key[:40]} : doit être interne et nommé {name}-…')
        if net.get('driver') or net.get('driver_opts'):
            fail(f'réseau {key[:40]} : driver / driver_opts refusés')
    volumes = cfg.get('volumes') or {}
    for key, vol in volumes.items():
        if vol.get('external') or not prefixed(vol.get('name', ''), name):
            fail(f'volume {key[:40]} : doit être propre au projet et nommé {name}-…')
        if vol.get('driver') or vol.get('driver_opts'):
            fail(f'volume {key[:40]} : driver / driver_opts refusés (montage de l\'hôte possible)')
    project_image = re.compile(r'^' + re.escape(name) + r'/(' + '|'.join(PROJECT_IMAGES) + r'):' + re.escape(a.tag) + r'$')
    for svc, s in (cfg.get('services') or {}).items():
        for key in s:
            if key in FORBIDDEN_SERVICE_KEYS or key not in ALLOWED_SERVICE_KEYS:
                fail(f'{svc} : clé « {key[:40]} » refusée')
        if s.get('pull_policy') not in (None, 'never'):
            fail(f'{svc} : pull_policy autre que never refusé')
        image = str(s.get('image', ''))
        own = bool(project_image.match(image))
        if not own and not THIRD_PARTY.match(image):
            fail(f'{svc} : image refusée (attendu {name}/<image>:<commit livré> ou image officielle épinglée)')
        cname = s.get('container_name')
        if cname is not None and not prefixed(cname, name):
            fail(f'{svc} : container_name doit commencer par {name}-')
        sec = [str(o).lower() for o in (s.get('security_opt') or [])]
        if not any(o.replace('=', ':') == 'no-new-privileges:true' for o in sec):
            fail(f'{svc} : security_opt no-new-privileges:true obligatoire')
        if any(not o.replace('=', ':').startswith('no-new-privileges:') for o in sec):
            fail(f'{svc} : security_opt autre que no-new-privileges refusé')
        if own and 'ALL' not in (s.get('cap_drop') or []):
            fail(f'{svc} : cap_drop ALL obligatoire pour les images du projet')
        if own and str(s.get('user', '')).split(':')[0] in ('root', '0'):
            fail(f'{svc} : utilisateur root refusé')
        mem = size_bytes(s.get('mem_limit', ''))
        if mem is None or mem <= 0 or mem > MAX_MEM:
            fail(f'{svc} : mem_limit obligatoire (≤ 1 Go)')
        swap = s.get('memswap_limit')
        if swap is not None and size_bytes(swap) != mem:
            fail(f'{svc} : memswap_limit doit égaler mem_limit (pas de swap)')
        cpus = s.get('cpus')
        try:
            cpus_ok = cpus is not None and 0 < float(cpus) <= MAX_CPUS
        except (TypeError, ValueError):
            cpus_ok = False
        if not cpus_ok:
            fail(f'{svc} : cpus obligatoire (≤ {MAX_CPUS:g})')
        if 'shm_size' in s:
            shm = size_bytes(s.get('shm_size'))
            if shm is None or shm > MAX_SHM:
                fail(f'{svc} : shm_size ≤ 256 Mo')
        pids = s.get('pids_limit')
        if not isinstance(pids, int) or pids <= 0 or pids > MAX_PIDS:
            fail(f'{svc} : pids_limit obligatoire (≤ {MAX_PIDS})')
        log = s.get('logging') or {}
        opts = log.get('options') or {}
        if log.get('driver') not in LOG_DRIVERS:
            fail(f'{svc} : logging.driver json-file ou local obligatoire')
        ms = size_bytes(opts.get('max-size', ''))
        if ms is None or ms <= 0 or ms > MAX_LOG_SIZE:
            fail(f'{svc} : logging.options.max-size obligatoire (≤ 50 Mo)')
        if not re.fullmatch(r'[1-5]', str(opts.get('max-file', '1'))):
            fail(f'{svc} : logging.options.max-file ≤ {MAX_LOG_FILES}')
        if set(opts) - {'max-size', 'max-file', 'compress'}:
            fail(f'{svc} : option de journalisation refusée')
        for v in s.get('volumes') or []:
            vtype = v.get('type')
            if vtype == 'volume':
                if v.get('source') not in volumes:
                    fail(f'{svc} : volume non déclaré par le projet')
            elif vtype == 'bind':
                if not under(str(v.get('source', '/')), a.root) or not v.get('read_only'):
                    fail(f'{svc} : montage de l\'hôte refusé (seulement en lecture seule, dans la livraison)')
            elif vtype != 'tmpfs':
                fail(f'{svc} : volume de type {str(vtype)[:20]} refusé')
        nets = s.get('networks') or {}
        for net in nets:
            if net not in networks:
                fail(f'{svc} : réseau non déclaré')
        labels = s.get('labels') or {}
        if isinstance(labels, list):
            labels = dict(item.split('=', 1) if '=' in item else (item, '') for item in labels)
        check_labels(svc, labels, a)
    finish('compose')


def cmd_thirdparty(path):
    cfg = json.load(open(path))
    for s in (cfg.get('services') or {}).values():
        image = str(s.get('image', ''))
        if THIRD_PARTY.match(image):
            print(image)


# --- oidc ---------------------------------------------------------------------------------------------
SHA256_DIGEST_INFO = bytes.fromhex('3031300d060960864801650304020105000420')


def b64u(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def cmd_oidc(argv):
    p = argparse.ArgumentParser(prog='deploy_policy.py oidc')
    p.add_argument('token')
    for opt in ('--jwks', '--repo', '--sha'):
        p.add_argument(opt, required=True)
    # --aud absent : pré-contrôle AVANT réception de l'archive (signature, émetteur, branche, commit, expiration) ;
    # l'audience (empreinte de l'archive) est vérifiée ensuite.
    p.add_argument('--aud')
    a = p.parse_args(argv)
    try:
        h64, p64, s64 = a.token.split('.')
        header, claims, sig = json.loads(b64u(h64)), json.loads(b64u(p64)), b64u(s64)
    except ValueError:
        fail('jeton illisible')
        return finish('oidc')
    if header.get('alg') != 'RS256':
        fail('algorithme du jeton refusé (RS256 attendu)')
        return finish('oidc')
    keys = [k for k in (json.load(open(a.jwks)).get('keys') or []) if k.get('kid') == header.get('kid') and k.get('kty') == 'RSA']
    if not keys:
        fail('clé de signature GitHub introuvable (kid)')
        return finish('oidc')
    n = int.from_bytes(b64u(keys[0]['n']), 'big')
    e = int.from_bytes(b64u(keys[0]['e']), 'big')
    k = (n.bit_length() + 7) // 8
    s = int.from_bytes(sig, 'big')
    if len(sig) != k or s >= n:
        fail('signature invalide')
        return finish('oidc')
    em = pow(s, e, n).to_bytes(k, 'big')
    t = SHA256_DIGEST_INFO + hashlib.sha256(f'{h64}.{p64}'.encode()).digest()
    expected = b'\x00\x01' + b'\xff' * (k - len(t) - 3) + b'\x00' + t
    if not hmac.compare_digest(em, expected):
        fail('signature invalide')
        return finish('oidc')
    now = time.time()
    want = {
        'iss': 'https://token.actions.githubusercontent.com',
        'aud': a.aud,
        'repository': a.repo,
        'ref': 'refs/heads/main',
        'workflow_ref': f'{a.repo}/.github/workflows/deploy.yml@refs/heads/main',
        'sha': a.sha,
    }
    if a.aud is None:
        want.pop('aud')
    elif not str(claims.get('aud', '')).startswith('raijin-depot-prod:'):
        fail('audience inattendue')
    for key, value in want.items():
        got = claims.get(key)
        if (got if isinstance(got, str) else json.dumps(got)) != value:
            fail(f'revendication {key} inattendue')
    if not (isinstance(claims.get('exp'), (int, float)) and claims['exp'] > now - 60):
        fail('jeton expiré')
    if not (isinstance(claims.get('iat'), (int, float)) and claims['iat'] < now + 300):
        fail('jeton émis dans le futur')
    if not errors:
        print(json.dumps({'run_id': claims.get('run_id'), 'workflow_ref': claims.get('workflow_ref'),
                          'event_name': claims.get('event_name'), 'iat': claims.get('iat')}))
    finish('oidc')


def main(argv):
    if len(argv) == 3 and argv[0] == 'bundle':
        return cmd_bundle(argv[1], argv[2])
    if len(argv) == 4 and argv[0] == 'images':
        return cmd_images(argv[1], argv[2], argv[3])
    if len(argv) == 2 and argv[0] == 'yamlcheck':
        return cmd_yamlcheck(argv[1])
    if len(argv) == 2 and argv[0] == 'envfiles':
        return cmd_envfiles(argv[1])
    if len(argv) == 3 and argv[0] == 'resolve':
        return cmd_resolve(argv[1], argv[2])
    if argv and argv[0] == 'compose':
        return cmd_compose(argv[1:])
    if len(argv) == 2 and argv[0] == 'thirdparty':
        return cmd_thirdparty(argv[1])
    if argv and argv[0] == 'oidc':
        return cmd_oidc(argv[1:])
    print('usage : deploy_policy.py bundle|images|envfiles|resolve|compose|thirdparty|oidc …', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    main(sys.argv[1:])
