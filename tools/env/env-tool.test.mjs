// Tests de tools/env/env-tool.mjs (node --test tools/env/). Fichiers factices dans un dossier temporaire.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FILES, collapse, parseEnv, run, splitForServer } from './env-tool.mjs';
import { VARIABLES, schemaIndex } from './env-schema.mjs';

// Valeurs factices assemblées à l'exécution : aucun littéral au format d'une clé dans le dépôt (scan gitleaks).
const fake = (...parts) => parts.join('');
const SENTINELS = {
  HELIUS_API_KEY: fake('SENTINEL', '-helius-', '0001'),
  STRIPE_SECRET_KEY: fake('sk_', 'test_', 'SENTINEL0002'),
  JWT_ACCESS_SECRET: 'SENTINEL-jwt-0003',
  MY_OLD_VAR: 'SENTINEL-old-0004',
};
const LOCAL = [
  '# mon vieux fichier en vrac',
  `MY_OLD_VAR=${SENTINELS.MY_OLD_VAR}`,
  'RATE_LIMIT_PER_MINUTE=99',
  `export HELIUS_API_KEY=${SENTINELS.HELIUS_API_KEY}`,
  'STRIPE_SECRET_KEY=',
  `STRIPE_SECRET_KEY=${SENTINELS.STRIPE_SECRET_KEY}`,
  'STRIPE_SECRET_KEY=',
  `JWT_ACCESS_SECRET="${SENTINELS.JWT_ACCESS_SECRET}"`,
  'APP_URL=http://localhost:4200',
  'GOOGLE_SERVICE_ACCOUNT_JSON="{',
  '  \\"type\\": \\"SENTINEL-json-0005\\"',
  '}"',
  '',
].join('\n');

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-env-'));
  for (const [k, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, FILES[k]), text, { mode: 0o644 });
  return dir;
}
function runIn(dir, args = []) {
  const lines = [];
  run(['--root', dir, ...args], {
    log: (s) => lines.push(s),
    now: new Date(2026, 10, 27, 10, 0, 0),
  });
  return lines.join('\n');
}
const read = (dir, k) => fs.readFileSync(path.join(dir, FILES[k]), 'utf8');
const values = (text) => collapse(parseEnv(text)).values;
const mode = (f) => fs.statSync(f).mode & 0o777;
function assertNoSecret(out) {
  for (const s of [
    ...Object.values(SENTINELS),
    'SENTINEL-json-0005',
    'SENTINEL',
  ])
    assert.ok(!out.includes(s), `valeur affichée : ${s}`);
}

test('schéma : noms uniques, sections connues, chaque variable décrite', () => {
  const idx = schemaIndex();
  assert.equal(idx.size, VARIABLES.length);
  for (const v of VARIABLES) {
    assert.ok(v.desc && !v.desc.includes('\n'), v.name);
    assert.ok((v.envs ?? []).length, `${v.name} : envs`);
  }
});

test('lecture : export, guillemets, plusieurs lignes, doublons', () => {
  const p = collapse(parseEnv(LOCAL));
  assert.equal(p.values.get('HELIUS_API_KEY').raw, SENTINELS.HELIUS_API_KEY);
  assert.equal(
    p.values.get('STRIPE_SECRET_KEY').raw,
    SENTINELS.STRIPE_SECRET_KEY,
  ); // vide n'efface pas
  assert.deepEqual(p.duplicates, ['STRIPE_SECRET_KEY']);
  assert.ok(p.values.get('GOOGLE_SERVICE_ACCOUNT_JSON').multiline);
});

test('organisation : valeurs conservées, sections, ordre, inconnues, sans doublon, 600', () => {
  const dir = tmpRepo({ local: LOCAL });
  const out = runIn(dir);
  assertNoSecret(out);
  const env = read(dir, 'local');
  const v = values(env);
  assert.equal(v.get('HELIUS_API_KEY').raw, SENTINELS.HELIUS_API_KEY);
  assert.equal(v.get('STRIPE_SECRET_KEY').raw, SENTINELS.STRIPE_SECRET_KEY);
  assert.equal(
    v.get('JWT_ACCESS_SECRET').raw,
    `"${SENTINELS.JWT_ACCESS_SECRET}"`,
  );
  assert.equal(v.get('RATE_LIMIT_PER_MINUTE').raw, '99');
  assert.equal(v.get('MY_OLD_VAR').raw, SENTINELS.MY_OLD_VAR);
  assert.ok(
    v.get('GOOGLE_SERVICE_ACCOUNT_JSON').raw.includes('SENTINEL-json-0005'),
  );
  assert.equal(env.match(/^STRIPE_SECRET_KEY=/gm).length, 1, 'doublon');
  // Sections numérotées dans l'ordre, avancés puis « Autres » à la fin.
  const titles = [...env.matchAll(/^# (\d+)\. (.+)$/gm)].map((m) => [
    Number(m[1]),
    m[2],
  ]);
  titles.forEach(([n], i) => assert.equal(n, i + 1));
  assert.match(titles[0][1], /^Base/);
  assert.match(titles.at(-2)[1], /^Réglages avancés/);
  assert.equal(titles.at(-1)[1], 'Autres (à vérifier)');
  assert.ok(
    env.indexOf('HELIUS_API_KEY=') < env.indexOf('RATE_LIMIT_PER_MINUTE='),
  );
  assert.ok(env.indexOf('RATE_LIMIT_PER_MINUTE=') < env.indexOf('MY_OLD_VAR='));
  // Une ligne de commentaire au-dessus de chaque variable du modèle.
  const lines = env.split('\n');
  lines.forEach((l, i) => {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    if (
      m &&
      m[1] !== 'MY_OLD_VAR' &&
      !l.startsWith('GOOGLE_SERVICE_ACCOUNT_JSON')
    )
      assert.match(lines[i - 1], /^# /, m[1]);
  });
  // Sauvegarde 600 et contenu d'origine.
  const bak = fs.readdirSync(dir).filter((f) => f.startsWith('.env.bak-'));
  assert.equal(bak.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, bak[0]), 'utf8'), LOCAL);
  for (const f of ['.env', '.env.dev', '.env.prod', bak[0]])
    assert.equal(mode(path.join(dir, f)), 0o600, f);
  assert.match(out, /STRIPE_SECRET_KEY apparaissait plusieurs fois/);
  assert.match(out, /MY_OLD_VAR/);
});

test('dev et prod : valeurs par environnement, clés communes reprises, secrets du VPS vides', () => {
  const dir = tmpRepo({ local: LOCAL });
  runIn(dir);
  const dev = values(read(dir, 'dev'));
  const prod = values(read(dir, 'prod'));
  assert.equal(dev.get('APP_DOMAIN').raw, 'dev.raijinshield.com');
  assert.equal(prod.get('APP_DOMAIN').raw, 'app.raijinshield.com');
  assert.equal(dev.get('RAIJIN_DEV_EDGE').raw, 'traefik-shared');
  assert.equal(dev.get('JOBS_ENABLED').raw, 'false');
  assert.equal(dev.get('HELIUS_API_KEY').raw, SENTINELS.HELIUS_API_KEY);
  assert.equal(prod.get('STRIPE_SECRET_KEY').raw, SENTINELS.STRIPE_SECRET_KEY);
  assert.equal(
    prod.get('JWT_ACCESS_SECRET').raw,
    '',
    'secret du VPS non repris de .env',
  );
  assert.equal(
    dev.get('GOOGLE_SERVICE_ACCOUNT_JSON'),
    undefined,
    'Google jamais en dev',
  );
  assert.equal(
    prod.get('GOOGLE_SERVICE_ACCOUNT_JSON').raw,
    '',
    'valeur sur plusieurs lignes non reprise',
  );
  assert.equal(prod.get('DATABASE_URL'), undefined, 'imposée par Compose');
  assert.equal(prod.get('MY_OLD_VAR'), undefined);
  assert.match(
    read(dir, 'prod'),
    /JWT_ACCESS_SECRET.*\n|généré par l'installation du VPS/,
  );
});

test('dev et prod : mise à jour sans écraser, variable vidée volontairement non remplie', () => {
  const dir = tmpRepo({
    local: LOCAL,
    dev: 'HELIUS_API_KEY=\nAPP_DOMAIN=autre-dev.raijinshield.com\nZZ_PERSO=1\n',
  });
  runIn(dir);
  const dev = values(read(dir, 'dev'));
  assert.equal(dev.get('HELIUS_API_KEY').raw, '');
  assert.equal(dev.get('APP_DOMAIN').raw, 'autre-dev.raijinshield.com');
  assert.equal(dev.get('ZZ_PERSO').raw, '1');
});

test('idempotence : 2e passe identique, sans nouvelle sauvegarde', () => {
  const dir = tmpRepo({ local: LOCAL });
  runIn(dir);
  const snap = () =>
    Object.fromEntries(
      fs
        .readdirSync(dir)
        .sort()
        .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
    );
  const first = snap();
  const out = runIn(dir);
  assert.deepEqual(snap(), first);
  assert.match(out, /déjà à jour/);
});

test('--check : rien écrit, noms des obligatoires vides seulement', () => {
  const dir = tmpRepo({ local: LOCAL });
  const out = runIn(dir, ['--check', '--example']);
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
  assert.equal(read(dir, 'local'), LOCAL);
  assertNoSecret(out);
  assert.match(out, /== \.env\.prod/);
  assert.match(out, /- RESEND_API_KEY/);
  assert.match(out, /- WATCHDOG_ALERT_EMAIL/);
  assert.doesNotMatch(
    out,
    /- JWT_ACCESS_SECRET/,
    'secret généré par le VPS non réclamé',
  );
  assert.doesNotMatch(out, /- TRAEFIK_NETWORK/, 'détecté par le VPS');
});

test('--example : valeurs factices seulement', () => {
  const dir = tmpRepo({ local: LOCAL });
  runIn(dir, ['--example']);
  const ex = read(dir, 'example');
  assert.ok(!ex.includes('SENTINEL'));
  const v = values(ex);
  assert.equal(v.get('HELIUS_API_KEY').raw, '');
  assert.match(v.get('JWT_ACCESS_SECRET').raw, /factice/);
  assert.equal(mode(path.join(dir, '.env.example')), 0o600);
});

test('découpage pour le serveur : fichiers Compose / API / banc, valeurs non vides, 600', () => {
  const dir = tmpRepo({
    local: LOCAL,
    prod: 'HELIUS_API_KEY=k\nWATCHDOG_ALERT_EMAIL=a@b.invalid\nBOT_SERVICE_TOKEN=t\nBENCH_MODE=shadow\nDATABASE_URL=x\nJWT_ACCESS_SECRET=\nZZ=1\n',
  });
  const p = collapse(parseEnv(read(dir, 'prod')));
  const { files, skipped } = splitForServer('prod', p);
  assert.deepEqual(files.api, ['HELIUS_API_KEY=k', 'BOT_SERVICE_TOKEN=t']);
  assert.deepEqual(files.compose, [
    'WATCHDOG_ALERT_EMAIL=a@b.invalid',
    'BOT_SERVICE_TOKEN=t',
  ]);
  assert.deepEqual(files.bench, [], 'banc sans BENCH_OWNER_EMAIL : rien');
  assert.ok(skipped.some((s) => s.startsWith('DATABASE_URL')));
  assert.ok(skipped.some((s) => s.startsWith('ZZ')));
  const out = path.join(dir, 'split');
  const log = runIn(dir, ['--split', out]);
  assert.ok(!log.includes('a@b.invalid'));
  assert.equal(mode(path.join(out, 'prod')), 0o700);
  assert.equal(mode(path.join(out, 'prod', '.env.api')), 0o600);
  assert.ok(!fs.existsSync(path.join(out, 'prod', '.env.bench-api')));
  assert.ok(!fs.existsSync(path.join(out, 'dev')), '.env.dev absent : rien');
});
