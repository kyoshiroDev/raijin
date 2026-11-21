#!/usr/bin/env node
// Génère src/environments/environment.local.ts (ignoré par Git) à partir de
// NG_APP_SUPABASE_URL / NG_APP_SUPABASE_ANON_KEY / NG_APP_VAPID_PUBLIC_KEY.
// Repris de l'ancien scripts/write-env.mjs du scanner : refuse toute clé qui n'est pas une clé
// publique anon/publishable, pour qu'une clé service_role ne parte jamais dans le navigateur.
// Lancé uniquement par l'utilisateur (build `--configuration=local`). Transitoire : supprimé au
// portage (phase 8 bis), quand supabase-js sera remplacé par l'API du banc.
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const target = 'src/environments/environment.local.ts';
const url = process.env.NG_APP_SUPABASE_URL;
const key = process.env.NG_APP_SUPABASE_ANON_KEY;
const vapid = process.env.NG_APP_VAPID_PUBLIC_KEY ?? '';
const fail = (msg) => {
  console.error(`write-env: ${msg}`);
  process.exit(1);
};

if (!url || !key) fail('NG_APP_SUPABASE_URL et NG_APP_SUPABASE_ANON_KEY sont requis.');

const isLocal = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
if (!isLocal && !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) fail('URL Supabase invalide.');

if (key.startsWith('sb_secret_')) fail('clé SECRÈTE refusée : utiliser uniquement la clé publishable/anon.');
const parts = key.split('.');
if (parts.length === 3) {
  let role;
  try {
    role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role;
  } catch {
    fail("la clé anon n'est pas un JWT valide.");
  }
  if (role !== 'anon') fail(`rôle de clé "${role}" refusé : seule la clé anon est admise dans le front.`);
} else if (!key.startsWith('sb_publishable_')) {
  fail('format de clé non reconnu.');
}

// Clé VAPID publique : base64url d'un point P-256 non compressé (65 octets → 87 caractères).
if (vapid && !/^B[A-Za-z0-9_-]{86}$/.test(vapid)) fail("NG_APP_VAPID_PUBLIC_KEY n'est pas une clé VAPID publique valide.");

writeFileSync(
  target,
  `// Généré par scripts/write-env.mjs — ne pas modifier, ne pas commiter.
export const environment = {
  production: true,
  supabaseUrl: ${JSON.stringify(url)},
  supabaseAnonKey: ${JSON.stringify(key)},
  vapidPublicKey: ${JSON.stringify(vapid)},
} as const;
`,
);
console.log('write-env: environment.local.ts écrit.');
