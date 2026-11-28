import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lecture d'un fichier de la charte (`libs/brand`) **au build** (le build tourne dans `apps/landing`) : aucune copie
 * versionnée dans la landing, aucune importation inter-projets par chemin relatif.
 */
export function brandFilePath(relativePath: string): string {
  return join(process.cwd(), '../../libs/brand', relativePath);
}

export function readBrandFile(relativePath: string): string {
  return readFileSync(brandFilePath(relativePath), 'utf8');
}
