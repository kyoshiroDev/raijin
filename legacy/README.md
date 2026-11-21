# legacy/ — référence en lecture seule (Raijin-banc-de-test)

Copie de l'ancien scanner (`raijin-old`) faite en phase 1 bis, **sans** `.git`, `node_modules`,
`.env*`, `.secrets/`, `dist`, `supabase/.temp`, `supabase/.branches`, `*.local.sql`.

| Dossier | Contenu | Usage |
|---|---|---|
| `supabase/` | migrations SQL, Edge Functions Deno, `config.toml`, SQL pg_cron | base de l'inventaire `docs/BENCH.md` et du portage (phase 8 bis) |
| `scripts/` | scripts Deno/Node de l'ancien dépôt (backtests, rattrapages, rotation de secrets) | référence pour le portage, **non exécutés** depuis ce dépôt |
| `docs/` | documentation de l'ancien scanner | référence |
| `vercel.json` | en-têtes (CSP) et réécritures de l'hébergement Vercel actuel | référence pour la config Traefik du banc |

Règles :
- Ce n'est **pas** un projet Nx : aucune cible, rien n'y est buildé ni linté (ignoré par Nx via
  `.nxignore`). Les valeurs [auth] de `supabase/config.toml` sont figées dans `password-rules.spec.ts` du banc.
- On n'exécute rien d'ici contre Supabase (aucun `supabase db push`, `functions deploy`…) : la
  production du banc continue de tourner telle quelle jusqu'à la bascule faite par l'utilisateur.
- Dossier supprimé après bascule validée (PROMPT.md §1 et §4.8).
