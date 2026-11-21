// Configuration de build du banc : valeurs FACTICES, versionnées volontairement.
// Aucune clé réelle ici. Pour un build pointant vers un vrai projet Supabase (usage local de
// l'utilisateur uniquement), générer environment.local.ts (ignoré par Git) avec
// `pnpm nx run raijin-banc-de-test:write-env` puis builder avec `--configuration=local`.
// Seules des valeurs PUBLIQUES (URL, clé anon/publishable, clé VAPID publique) sont acceptées.
export const environment = {
  production: false,
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'FACTICE_ANON_KEY',
  vapidPublicKey: '',
} as const;
