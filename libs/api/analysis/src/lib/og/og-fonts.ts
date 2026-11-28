import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Polices de la charte pour l'image OG, en WOFF (satori ne lit pas le WOFF2) : fichiers
 * `@fontsource` (licence OFL) sous-ensemble latin, déjà dépendances du workspace.
 * Recherche, dans l'ordre : `OG_FONTS_DIR`, `<bundle>/assets/fonts` (copiés au build de l'API),
 * puis le paquet `@fontsource` résolu depuis le répertoire courant.
 */
export const OG_FONT_FILES = [
  { name: 'Space Grotesk', weight: 700, pkg: '@fontsource/space-grotesk', file: 'space-grotesk-latin-700-normal.woff' },
  { name: 'Inter', weight: 400, pkg: '@fontsource/inter', file: 'inter-latin-400-normal.woff' },
  { name: 'JetBrains Mono', weight: 500, pkg: '@fontsource/jetbrains-mono', file: 'jetbrains-mono-latin-500-normal.woff' },
] as const;

export interface OgFont {
  readonly name: string;
  readonly data: Buffer;
  readonly weight: 400 | 500 | 700;
  readonly style: 'normal';
}

function candidates(fontsDir: string | null, pkg: string, file: string): string[] {
  const list: string[] = [];
  if (fontsDir) list.push(join(fontsDir, file));
  list.push(join(__dirname, 'assets', 'fonts', file));
  try {
    const load = createRequire(join(process.cwd(), 'package.json'));
    list.push(load.resolve(`${pkg}/files/${file}`));
  } catch {
    // Paquet absent (image de production sans @fontsource) : dossiers ci-dessus seulement.
  }
  return list;
}

/** Charge les polices ; lève si l'une d'elles est introuvable (l'appelant sert l'image de repli). */
export function loadOgFonts(fontsDir: string | null): OgFont[] {
  return OG_FONT_FILES.map(({ name, weight, pkg, file }) => {
    const path = candidates(fontsDir, pkg, file).find((candidate) => existsSync(candidate));
    if (!path) throw new Error(`Police OG introuvable : ${file}`);
    return { name, weight, style: 'normal', data: readFileSync(path) };
  });
}
