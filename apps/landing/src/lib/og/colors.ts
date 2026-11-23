import { readBrandFile } from './brand-files';

interface BrandTokens {
  color: { tokens: { name: string; value: { dark: string } }[] };
}

type ColorName = 'base' | 'surface' | 'surface-raised' | 'line' | 'ink' | 'ink-muted' | 'thunder' | 'safe' | 'warn' | 'danger';
const NAMES: readonly ColorName[] = ['base', 'surface', 'surface-raised', 'line', 'ink', 'ink-muted', 'thunder', 'safe', 'warn', 'danger'];

/** Couleurs du thème sombre lues dans `libs/brand/tokens.json` (aucune valeur en dur, docs/ARCHITECTURE.md §15.6). */
export function brandColors(): Readonly<Record<ColorName, string>> {
  const tokens = JSON.parse(readBrandFile('tokens.json')) as BrandTokens;
  const byName = new Map(tokens.color.tokens.map((token) => [token.name, token.value.dark]));
  const colors = {} as Record<ColorName, string>;
  for (const name of NAMES) {
    const value = byName.get(name);
    if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Couleur de charte absente ou invalide : ${name}`);
    colors[name] = value;
  }
  return colors;
}
