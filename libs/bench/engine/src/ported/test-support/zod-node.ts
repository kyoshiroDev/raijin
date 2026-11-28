// Port Node (bench-engine) : `zod/v3` se résout normalement (dépendance `zod` du monorepo). Sous Deno, ce fichier
// enregistrait un crochet de résolution pour `npm:zod@^3.24` ; il ne reste qu'un indicateur pour les tests d'origine.
export function setupZodForNode(): boolean {
  return true;
}
