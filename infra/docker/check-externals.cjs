#!/usr/bin/env node
/**
 * Vérifie, au build de l'image, que CHAQUE module externe requis par les bundles de l'API (main.js, cli.js…) se
 * résout depuis leur dossier, avec les seules dépendances de production installées. Échoue (code 1) en listant
 * les manquants : une image qui planterait au démarrage (« Cannot find module ») ne peut pas être produite.
 *
 * Usage : node check-externals.cjs <dossier du bundle> [fichier.js…]   (défaut : main.js cli.js)
 * Les modules sont lus dans les `require("…")` littéraux émis par webpack pour les dépendances externes.
 * Refuse aussi toute lib interne `@raijin/*` (require d'un bundle, dépendance du package.json généré ou entrée
 * `file:`/`link:` du lockfile élagué) : les libs du monorepo doivent être bundlées par webpack, jamais installées.
 */
'use strict';
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { builtinModules, createRequire } = require('node:module');

const dir = resolve(process.argv[2] || '.');
const files = process.argv.length > 3 ? process.argv.slice(3) : ['main.js', 'cli.js'];
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const found = new Set();

for (const file of files) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    console.error(`check-externals : ${path} introuvable`);
    process.exit(1);
  }
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(/\brequire\(\s*(["'])([^"'\s]+)\1\s*\)/g)) {
    const id = match[2];
    if (id.startsWith('.') || id.startsWith('/') || builtins.has(id) || builtins.has(id.split('/')[0])) continue;
    found.add(id);
  }
}

const load = createRequire(join(dir, 'package.json'));
const missing = [];
for (const id of [...found].sort()) {
  try {
    load.resolve(id);
  } catch {
    missing.push(id);
  }
}

// Libs internes : jamais externes (le nom du package.json de l'app elle-même est autorisé).
const INTERNAL = /^@raijin\//;
const internal = [...found].filter((id) => INTERNAL.test(id)).map((id) => `require("${id}")`);
const manifestPath = join(dir, 'package.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[section] || {})) {
      if (INTERNAL.test(name)) internal.push(`package.json ${section} ${name}`);
    }
  }
}
const lockPath = join(dir, 'pnpm-lock.yaml');
if (existsSync(lockPath)) {
  for (const line of readFileSync(lockPath, 'utf8').split('\n')) {
    if (/['"]?@raijin\/[^'":\s]+['"]?:|workspace_modules|:\s*['"]?(?:file|link):/.test(line)) internal.push(`pnpm-lock.yaml « ${line.trim()} »`);
  }
}

console.log(`check-externals : ${found.size} module(s) externe(s) requis par ${files.join(', ')}`);
console.log([...found].sort().map((id) => `  ${missing.includes(id) ? 'MANQUANT' : 'ok      '} ${id}`).join('\n'));
if (internal.length > 0) {
  console.error(`check-externals : lib(s) interne(s) @raijin/* non bundlée(s) :\n  ${[...new Set(internal)].join('\n  ')}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`check-externals : ${missing.length} module(s) introuvable(s) : ${missing.join(', ')}`);
  process.exit(1);
}
