// Vérifie la cohérence de libs/brand : tokens.json valide, chaque couleur de tokens.json
// présente dans tokens.css (thème sombre @theme et thème clair [data-theme="light"]),
// et présence des icônes PWA. Lecture seule : aucun fichier de la charte n'est modifié.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', 'libs', 'brand');
const css = readFileSync(join(root, 'tokens.css'), 'utf8');
const json = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));
const errors = [];

const themeBlock = css.match(/@theme\s*{([\s\S]*?)}/)?.[1] ?? '';
const lightBlock = css.match(/\[data-theme="light"\]\s*{([\s\S]*?)}/)?.[1] ?? '';

const readVar = (block, name) =>
  block.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1];

/** Forme comparable d'une couleur : « #facc15 » ou liste de nombres pour rgb()/rgba(). */
const canon = (value) => {
  const v = value.trim().toLowerCase();
  return v.startsWith('#') ? v : (v.match(/[\d.]+/g) ?? []).map(Number).join(',');
};

for (const token of json.color.tokens) {
  const dark = readVar(themeBlock, token.name);
  if (!dark) {
    errors.push(`--color-${token.name} absent du bloc @theme de tokens.css`);
    continue;
  }
  if (canon(dark) !== canon(token.value.dark)) {
    errors.push(`--color-${token.name} : tokens.css=${dark} ≠ tokens.json=${token.value.dark}`);
  }
  // Sans surcharge dans [data-theme="light"], la valeur sombre s'applique aussi en clair.
  const light = readVar(lightBlock, token.name) ?? dark;
  if (canon(light) !== canon(token.value.light)) {
    errors.push(`--color-${token.name} (clair) : tokens.css=${light} ≠ tokens.json=${token.value.light}`);
  }
}

for (const icon of ['favicon.svg', 'icon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png']) {
  if (!existsSync(join(root, 'icons', icon))) errors.push(`icône manquante : icons/${icon}`);
}

if (errors.length > 0) {
  console.error(`libs/brand : ${errors.length} incohérence(s)\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`libs/brand : ${json.color.tokens.length} couleurs cohérentes entre tokens.json et tokens.css, icônes présentes.`);
