#!/usr/bin/env node
/**
 * Vérifie, au build de l'image, que CHAQUE module externe requis par les bundles de l'API (main.js, cli.js…) se
 * résout depuis leur dossier, avec les seules dépendances de production installées. Échoue (code 1) en listant
 * les manquants : une image qui planterait au démarrage (« Cannot find module ») ne peut pas être produite.
 *
 * Usage : node check-externals.cjs <dossier du bundle> [fichier.js…]   (défaut : main.js cli.js)
 * Les modules sont lus dans les `require("…")` littéraux émis par webpack pour les dépendances externes.
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

console.log(`check-externals : ${found.size} module(s) externe(s) requis par ${files.join(', ')}`);
console.log([...found].sort().map((id) => `  ${missing.includes(id) ? 'MANQUANT' : 'ok      '} ${id}`).join('\n'));
if (missing.length > 0) {
  console.error(`check-externals : ${missing.length} module(s) introuvable(s) : ${missing.join(', ')}`);
  process.exit(1);
}
