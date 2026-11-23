# server-push (`@raijin/server-push`)

Brique serveur (Node) partagée par `apps/api` et `apps/raijin-banc-de-test-api`, sans logique métier.
Tags `scope:server`, `type:util` : dépend seulement de `scope:shared` ; ne dépend jamais de
`scope:api` ni de `scope:bench`. Décisions : `docs/ARCHITECTURE.md` §17.1. Contenu extrait en phase 8 bis (T3) : `PushSender` (contrat), `WebPushSender` (VAPID, aes128gcm, endpoint revalidé contre `PUSH_SERVICE_HOSTS`, jamais journalisé), `FakePushSender` (tests ; l’appelant le refuse en production). La paire VAPID est passée par l’application.

`pnpm nx run-many -t lint typecheck test build -p server-push`
