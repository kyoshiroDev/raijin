#!/usr/bin/env node
// Organise les fichiers de variables de Raijin Shield, sans jamais afficher une valeur.
// À lancer PAR TOI depuis la racine du dépôt : bash tools/env/organiser-env.sh [options]
//
//   (sans option)  sauvegarde puis réorganise .env (ta machine), crée ou complète .env.dev et .env.prod
//   --check        n'écrit rien : affiche seulement les variables obligatoires encore vides (noms seulement)
//   --example      régénère aussi .env.example depuis le modèle (valeurs factices)
//   --split <dir>  (utilisé par infra/vps-install.sh) découpe .env.dev / .env.prod en fichiers du serveur :
//                  <dir>/dev/.env, <dir>/dev/.env.api, <dir>/prod/.env, .env.api, .env.bench-api
//   --root <dir>   dossier du dépôt (défaut : dossier courant)
//   Sauvegardes : <fichier>.bak-<date>, les 3 plus récentes par fichier (les plus anciennes écrasées puis supprimées).
//
// Modèle de référence : tools/env/env-schema.mjs. Aucune dépendance. Tous les fichiers écrits en 600.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OTHER_SECTION_TITLE,
  SECTIONS,
  VARIABLES,
  VPS_GEN_NOTE,
  schemaIndex,
} from './env-schema.mjs';

const SCHEMA = schemaIndex();
const SERVER_KINDS = ['dev', 'prod'];
export const FILES = {
  local: '.env',
  dev: '.env.dev',
  prod: '.env.prod',
  example: '.env.example',
};
const KIND_LABEL = {
  local: 'ta machine (développement local)',
  dev: 'serveur dev (dev.raijinshield.com), envoyé au VPS par bash infra/vps-install.sh',
  prod: 'serveur prod (app.raijinshield.com), envoyé au VPS par bash infra/vps-install.sh',
};
const RULE = '# ' + '-'.repeat(69);
const BIG_RULE = '# ' + '='.repeat(69);

// ------------------------------------------------------------------------------------------------ lecture
/** Valeur vide : rien, "" ou ''. */
export function isEmptyRaw(raw) {
  const t = (raw ?? '').trim();
  return t === '' || t === '""' || t === "''";
}

/** Valeur sans guillemets englobants (pour des contrôles internes, jamais affichée). */
function unquote(raw) {
  const t = (raw ?? '').trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0]))
    return t.slice(1, -1);
  return t;
}

/**
 * Lit un fichier .env. Garde la valeur brute telle qu'écrite (guillemets compris), gère « export » et les
 * valeurs entre guillemets sur plusieurs lignes. Renvoie les affectations dans l'ordre.
 */
export function parseEnv(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
      lines[i],
    );
    if (!m) continue;
    let raw = m[2].trim();
    const q = raw[0];
    if ((q === '"' || q === "'") && !closesQuote(raw.slice(1), q)) {
      // Valeur sur plusieurs lignes : jusqu'à la ligne qui ferme le guillemet.
      let j = i + 1;
      const parts = [m[2].trimStart()];
      while (j < lines.length) {
        parts.push(lines[j]);
        if (closesQuote(lines[j], q)) break;
        j++;
      }
      raw = parts.join('\n').trimEnd();
      i = Math.min(j, lines.length - 1);
    }
    entries.push({ name: m[1], raw, multiline: raw.includes('\n') });
  }
  return entries;
}
function closesQuote(s, q) {
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && q === '"') {
      k++;
      continue;
    }
    if (s[k] === q) return true;
  }
  return false;
}

/**
 * Une valeur par nom. En cas de doublon : la dernière valeur non vide (une valeur vide n'efface pas une
 * valeur renseignée plus haut) ; les noms en double sont signalés.
 */
export function collapse(entries) {
  const values = new Map();
  const counts = new Map();
  const order = [];
  for (const e of entries) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    if (!values.has(e.name)) order.push(e.name);
    const prev = values.get(e.name);
    if (prev === undefined || !isEmptyRaw(e.raw) || isEmptyRaw(prev.raw))
      values.set(e.name, e);
  }
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  return { values, order, duplicates };
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink())
    throw new Error(
      `${path.basename(file)} est un lien symbolique : rien n'est fait.`,
    );
  return collapse(parseEnv(fs.readFileSync(file, 'utf8')));
}

// ------------------------------------------------------------------------------------------------ écriture
const isRequired = (v, kind) => (v.required ?? []).includes(kind);
const proposed = (v, kind) =>
  (v.envs ?? []).includes(kind) || v.rec?.[kind] !== undefined;
const isServer = (kind) => SERVER_KINDS.includes(kind);

function commentFor(v, kind) {
  const tags = [];
  if (isRequired(v, kind)) tags.push('obligatoire');
  if (v.secret) tags.push('secret');
  if (isServer(kind) && v.vpsGen) tags.push(VPS_GEN_NOTE + ', laisser vide');
  else if (isServer(kind) && v.vpsFill)
    tags.push("renseigné par l'installation du VPS si détecté");
  if (isServer(kind) && v.imposed)
    tags.push('ignorée sur le serveur (imposée par docker-compose)');
  else if (!proposed(v, kind) && kind !== 'example')
    tags.push('non utilisée dans ce fichier, à vérifier');
  let line = `# ${v.desc}`;
  if (tags.length) line += ` [${tags.join(', ')}]`;
  if (v.link) line += ` — ${v.link}`;
  else if (v.def && v.advanced) line += ` — défaut : ${v.def}`;
  return line;
}

/**
 * Construit le contenu d'un fichier (.env, .env.dev, .env.prod ou .env.example).
 * existing : valeurs actuelles du fichier (ou null) ; local : valeurs de .env (pour les clés communes).
 */
export function buildFile(kind, existing, local) {
  const values = existing?.values ?? new Map();
  const target = kind === 'example' ? 'local' : kind;
  const chosen = new Map(); // nom -> valeur brute
  for (const v of VARIABLES) {
    if (kind === 'example') {
      if (!proposed(v, 'local')) continue;
      chosen.set(
        v.name,
        v.example ?? (v.secret ? '' : (v.rec?.local ?? v.def ?? '')),
      );
      continue;
    }
    if (values.has(v.name)) {
      chosen.set(v.name, values.get(v.name).raw);
      continue;
    }
    if (!proposed(v, kind)) continue;
    const rec = v.rec?.[kind];
    if (v.advanced && rec === undefined) continue;
    const shared = local?.values.get(v.name);
    if (
      isServer(kind) &&
      (v.share ?? []).includes(kind) &&
      shared &&
      !isEmptyRaw(shared.raw) &&
      !shared.multiline
    ) {
      chosen.set(v.name, shared.raw);
    } else {
      chosen.set(v.name, rec ?? '');
    }
  }
  const unknown =
    kind === 'example'
      ? []
      : (existing?.order ?? []).filter((n) => !SCHEMA.has(n));

  const out = [BIG_RULE];
  if (kind === 'example') {
    out.push(
      '# Raijin Shield — modèle de .env (VALEURS FACTICES, commité). Copie-le en .env puis remplis.',
    );
  } else {
    out.push(`# Raijin Shield — variables de ${KIND_LABEL[kind]}`);
    out.push(
      '# Organisé par : bash tools/env/organiser-env.sh (jamais commité, droits 600).',
    );
  }
  out.push(
    '# Une ligne de commentaire par variable : à quoi elle sert, [obligatoire, secret…], où l’obtenir.',
  );
  out.push(
    '# Détail complet : docs/ENV.md. Modèle : tools/env/env-schema.mjs.',
  );
  out.push(BIG_RULE);

  const missing = [];
  let vpsGenerated = 0;
  let n = 0;
  for (const s of SECTIONS) {
    const vars = VARIABLES.filter(
      (v) => v.section === s.id && chosen.has(v.name),
    );
    if (!vars.length) continue;
    vars.sort(
      (a, b) => Number(isRequired(b, target)) - Number(isRequired(a, target)),
    );
    n++;
    out.push('', RULE, `# ${n}. ${s.title}`, RULE);
    for (const v of vars) {
      const raw = chosen.get(v.name);
      out.push(commentFor(v, kind), `${v.name}=${raw}`);
      if (kind === 'example' || !isEmptyRaw(raw)) continue;
      if (isServer(kind) && v.vpsGen) vpsGenerated++;
      else if (isRequired(v, kind) && !(isServer(kind) && v.vpsFill))
        missing.push({ section: `${n}. ${s.title}`, name: v.name });
    }
  }
  if (unknown.length) {
    n++;
    out.push('', RULE, `# ${n}. ${OTHER_SECTION_TITLE}`, RULE);
    out.push(
      '# Variables absentes du modèle (faute de frappe ? ancienne variable ?) : valeurs conservées telles quelles.',
    );
    for (const name of unknown) out.push(`${name}=${values.get(name).raw}`);
  }
  out.push('');
  return { text: out.join('\n'), missing, vpsGenerated, unknown, chosen };
}

/** Contrôles sans afficher de valeur : renvoie des avertissements (noms seulement). */
export function warningsFor(kind, existing, chosen) {
  const w = [];
  for (const name of existing?.duplicates ?? []) {
    w.push(
      `${name} apparaissait plusieurs fois : une seule ligne gardée (la dernière valeur renseignée ; l'ancien fichier est dans la sauvegarde).`,
    );
  }
  const val = (name) => unquote(chosen.get(name) ?? '');
  if (kind !== 'prod' && /^(sk|rk)_live_/.test(val('STRIPE_SECRET_KEY'))) {
    w.push(
      'STRIPE_SECRET_KEY : clé « live » hors production, refusée par l’API et par le déploiement du dev.',
    );
  }
  for (const name of ['DEV_BASIC_AUTH_USERS', 'BENCH_BASIC_AUTH_USERS']) {
    const raw = (chosen.get(name) ?? '').trim();
    if (raw.includes('$') && !(raw.startsWith("'") && raw.endsWith("'")))
      w.push(`${name} : à mettre ENTRE APOSTROPHES (le hash contient des $).`);
  }
  const vp = isEmptyRaw(chosen.get('VAPID_PUBLIC_KEY'));
  const vk = isEmptyRaw(chosen.get('VAPID_PRIVATE_KEY'));
  if (chosen.has('VAPID_PUBLIC_KEY') && vp !== vk)
    w.push(
      'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY : une seule des deux est renseignée (les deux ou aucune).',
    );
  if (isServer(kind)) {
    for (const [name, raw] of chosen)
      if (raw.includes('\n'))
        w.push(
          `${name} : valeur sur plusieurs lignes, non envoyable au serveur (mets-la sur une seule ligne).`,
        );
  }
  return w;
}

function writeSecure(file, text) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw new Error(
      `${path.basename(file)} est un lien symbolique : rien n'est écrit.`,
    );
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function stamp(now) {
  const p = (x) => String(x).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
function backup(file, now) {
  let dest = `${file}.bak-${stamp(now)}`;
  for (let i = 2; fs.existsSync(dest); i++)
    dest = `${file}.bak-${stamp(now)}-${i}`;
  fs.copyFileSync(file, dest);
  fs.chmodSync(dest, 0o600);
  return path.basename(dest);
}

/** Sauvegardes gardées par fichier (.env.bak-*, .env.dev.bak-*…) : les plus récentes ; elles contiennent des secrets. */
export const KEEP_BACKUPS = 3;
const BACKUP_RE = /^(.+)\.bak-(\d{8}-\d{6})(?:-(\d+))?$/;
/** Sauvegardes de `file` (noms), de la plus récente à la plus ancienne. */
function backupsOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return fs
    .readdirSync(dir)
    .map((n) => [n, BACKUP_RE.exec(n)])
    .filter(([, m]) => m && m[1] === base)
    .map(([n, m]) => [n, `${m[2]}-${String(m[3] ?? 1).padStart(6, '0')}`])
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([n]) => path.join(dir, n));
}
/** Efface une sauvegarde : contenu écrasé par des zéros puis fichier supprimé (lien symbolique : seulement retiré). */
function shred(f) {
  const st = fs.lstatSync(f);
  if (st.isFile() && st.size > 0) {
    const fd = fs.openSync(f, 'r+');
    try {
      const zeros = Buffer.alloc(Math.min(st.size, 1 << 16));
      for (let pos = 0; pos < st.size; pos += zeros.length)
        fs.writeSync(fd, zeros, 0, Math.min(zeros.length, st.size - pos), pos);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.unlinkSync(f);
}
/** Ne garde que les KEEP_BACKUPS sauvegardes les plus récentes de `file` ; renvoie le nombre de sauvegardes effacées. */
export function pruneBackups(file, keep = KEEP_BACKUPS) {
  const old = backupsOf(file).slice(keep);
  for (const f of old) shred(f);
  return old.length;
}

function gitIgnored(root, name) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', name], {
    cwd: root,
    stdio: 'ignore',
  });
  return r.status !== 1; // 0 = ignoré ; 128 = pas un dépôt Git (rien à vérifier)
}

// ------------------------------------------------------------------------------------------------ découpage
/** Fichiers du serveur à partir de .env.dev / .env.prod (valeurs non vides, connues, non imposées). */
export function splitForServer(kind, parsed) {
  const files = { compose: [], api: [], bench: [] };
  const skipped = [];
  if (!parsed) return { files, skipped };
  const owner = parsed.values.get('BENCH_OWNER_EMAIL');
  const benchOn = kind === 'prod' && owner && !isEmptyRaw(owner.raw);
  for (const name of parsed.order) {
    const e = parsed.values.get(name);
    const v = SCHEMA.get(name);
    if (isEmptyRaw(e.raw)) continue;
    if (!v) {
      skipped.push(`${name} (inconnue du modèle)`);
      continue;
    }
    if (v.imposed || !proposed(v, kind) || !(v.vps ?? []).length) {
      skipped.push(`${name} (inutile sur le serveur ${kind})`);
      continue;
    }
    if (e.multiline) {
      skipped.push(`${name} (valeur sur plusieurs lignes)`);
      continue;
    }
    for (const t of v.vps) {
      if (t === 'bench' && !benchOn) continue;
      files[t].push(`${name}=${e.raw}`);
    }
  }
  return { files, skipped };
}
const SERVER_FILE = {
  compose: '.env',
  api: '.env.api',
  bench: '.env.bench-api',
};

// ------------------------------------------------------------------------------------------------ programme
export function run(
  argv,
  {
    root = process.cwd(),
    now = new Date(),
    log = (s) => process.stdout.write(s + '\n'),
  } = {},
) {
  const opts = { check: false, example: false, split: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--example') opts.example = true;
    else if (a === '--split') opts.split = argv[++i];
    else if (a === '--root') root = argv[++i];
    else if (a === '-h' || a === '--help') {
      log(
        fs
          .readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('\n')
          .slice(1, 14)
          .map((l) => l.replace(/^\/\/ ?/, ''))
          .join('\n'),
      );
      return 0;
    } else throw new Error(`option inconnue : ${a} (--help)`);
  }
  if (!root) throw new Error('--root : dossier manquant');
  const file = (k) => path.join(root, FILES[k]);

  if (opts.split) {
    const out = path.resolve(opts.split);
    for (const kind of SERVER_KINDS) {
      const parsed = readEnvFile(file(kind));
      if (!parsed) continue;
      const { files, skipped } = splitForServer(kind, parsed);
      fs.mkdirSync(path.join(out, kind), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(out, kind), 0o700);
      const counts = [];
      for (const [t, lines] of Object.entries(files)) {
        if (!lines.length) continue;
        writeSecure(
          path.join(out, kind, SERVER_FILE[t]),
          lines.join('\n') + '\n',
        );
        counts.push(`${SERVER_FILE[t]} : ${lines.length}`);
      }
      log(
        `${FILES[kind]} → serveur ${kind} : ${counts.join(', ') || 'aucune valeur'} variable(s) renseignée(s).`,
      );
      for (const s of skipped) log(`  non envoyée : ${s}`);
    }
    return 0;
  }

  log(
    opts.check
      ? 'Vérification seulement (--check) : aucun fichier modifié.'
      : 'Organisation des fichiers de variables (aucune valeur affichée).',
  );
  const local = readEnvFile(file('local'));
  const plans = [];
  for (const kind of ['local', ...SERVER_KINDS]) {
    const existing = kind === 'local' ? local : readEnvFile(file(kind));
    plans.push({ kind, existing, built: buildFile(kind, existing, local) });
  }
  let problems = 0;
  let pruned = 0;
  for (const { kind, existing, built } of plans) {
    const f = file(kind);
    const before = existing ? fs.readFileSync(f, 'utf8') : null;
    const changed = before !== built.text;
    log('');
    log(`== ${FILES[kind]} — ${KIND_LABEL[kind].split(',')[0]} ==`);
    if (!opts.check && changed) {
      const bak = existing ? backup(f, now) : null;
      writeSecure(f, built.text);
      log(existing ? `  réorganisé (sauvegarde : ${bak})` : '  créé');
      if (existing) pruned += pruneBackups(f);
    } else if (!opts.check) {
      fs.chmodSync(f, 0o600);
      log('  déjà à jour');
    } else {
      log(
        existing
          ? changed
            ? '  serait réorganisé'
            : '  déjà à jour'
          : "  n'existe pas encore (serait créé)",
      );
    }
    if (built.missing.length) {
      log('  Obligatoires encore vides :');
      let cur = '';
      for (const m of built.missing) {
        if (m.section !== cur) log(`    ${(cur = m.section)}`);
        log(`      - ${m.name}`);
      }
      problems += built.missing.length;
    } else {
      log('  Obligatoires : rien ne manque.');
    }
    if (built.vpsGenerated)
      log(
        `  ${built.vpsGenerated} secret(s) laissé(s) vide(s) : ${VPS_GEN_NOTE}.`,
      );
    if (built.unknown.length)
      log(
        `  À vérifier (inconnues du modèle, gardées dans « ${OTHER_SECTION_TITLE} ») : ${built.unknown.join(', ')}`,
      );
    for (const w of warningsFor(kind, existing, built.chosen))
      log(`  ATTENTION : ${w}`);
    if (!gitIgnored(root, FILES[kind]))
      log(
        `  ATTENTION : ${FILES[kind]} n'est pas ignoré par Git (.gitignore) : ne le commite pas.`,
      );
  }
  if (opts.example) {
    const built = buildFile('example', null, null);
    if (!opts.check) writeSecure(file('example'), built.text);
    log('');
    log(
      `== ${FILES.example} — ${opts.check ? 'serait régénéré' : 'régénéré'} depuis le modèle (valeurs factices) ==`,
    );
  }
  log('');
  log(
    problems
      ? `${problems} variable(s) obligatoire(s) à remplir (voir ci-dessus).`
      : 'Toutes les variables obligatoires sont renseignées.',
  );
  const kept = ['local', ...SERVER_KINDS].reduce(
    (n, k) => n + backupsOf(file(k)).length,
    0,
  );
  if (kept || pruned)
    log(
      `Rappel : ${kept} sauvegarde(s) .env*.bak-* gardée(s) (les ${KEEP_BACKUPS} plus récentes par fichier${pruned ? `, ${pruned} plus ancienne(s) écrasée(s) puis supprimée(s)` : ''}). Elles contiennent tes secrets : supprime-les dès que tu n'en as plus besoin (l'écrasement n'est pas garanti sur un SSD ; ne les commite jamais).`,
    );
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`ERREUR : ${e.message}\n`);
    process.exitCode = 1;
  }
}
