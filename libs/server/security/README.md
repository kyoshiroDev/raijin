# server-security (`@raijin/server-security`)

Brique serveur (Node) partagée par `apps/api` et `apps/raijin-banc-de-test-api`, sans logique métier.
Tags `scope:server`, `type:util` : dépend seulement de `scope:shared` ; ne dépend jamais de
`scope:api` ni de `scope:bench`. Décisions : `docs/ARCHITECTURE.md` §17.1. Contenu extrait en phase 8 bis (T3) : `hashPassword` / `verifyPassword` / `createDummyPasswordVerifier` (argon2id OWASP), TOTP RFC 6238 (`matchTotp`, `otpauthUri`, base32), secret-box AES-256-GCM (`encryptTotpSecret`, `decryptTotpSecret`, `recoveryCodeKey(clé, info)` : `info` HKDF propre à chaque application), codes de secours HMAC. Aucune variable d’environnement lue.

`pnpm nx run-many -t lint typecheck test build -p server-security`
