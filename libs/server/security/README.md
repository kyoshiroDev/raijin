# server-security (`@raijin/server-security`)

Brique serveur (Node) partagée par `apps/api` et `apps/raijin-banc-de-test-api`, sans logique métier.
Tags `scope:server`, `type:util` : dépend seulement de `scope:shared` ; ne dépend jamais de
`scope:api` ni de `scope:bench`. Décisions : `docs/ARCHITECTURE.md` §17.1. Contenu extrait en phase 8 bis (T3).

`pnpm nx run-many -t lint typecheck test build -p server-security`
