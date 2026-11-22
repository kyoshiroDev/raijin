# OPS-LOG — Raijin Shield

Journal des actions faites dans les tableaux de bord en ligne (agent `ops-chrome`, PROMPT.md §12).
Aucune valeur secrète n'est jamais notée ici (ni clé, ni préfixe de clé).

| Date | Service | Page | Action | Valeur non secrète / ancienne valeur |
|---|---|---|---|---|
| 2026-11-22 | Helius | dashboard.helius.dev → tableau de bord | Constat (lecture) | Compte dédié Raijin connecté. Plan **Free**. Un seul projet, nom auto-généré « Singerrag » (pas de création de projet proposée dans le menu des projets). Crédits : 4 % utilisés. Projet **non renommé** (décision laissée à l'utilisateur). |
| 2026-11-22 | Helius | dashboard.helius.dev → API Keys | Constat (lecture) | Clés existantes, non modifiées : « Llamasage » (créée le 21/11 21 h 14, jamais utilisée, sans restriction) et « Raijin » (créée le 21/11 21 h 45, **utilisée** le 22/11 vers 1 h 15, sans restriction). |
| 2026-11-22 | Helius | dashboard.helius.dev → API Keys → Create key | Création de clé | Nom « **raijin-api** » (et non « raijin », pour ne pas la confondre avec la clé « Raijin » existante déjà utilisée). Contrôle d'accès : Unrestricted. Destination : `HELIUS_API_KEY` (apps/api). |
| 2026-11-22 | Helius | dashboard.helius.dev → API Keys → Create key | Création de clé | Nom « **raijin-banc-de-test** ». Contrôle d'accès : Unrestricted. Destination : `BENCH_HELIUS_API_KEY` (raijin-banc-de-test-api). |
| 2026-11-22 | Helius | API Keys → Access control (raijin-api) | Consultation, fermé sans enregistrer | Restrictions proposées : domaines, IP, CIDR. Aucune appliquée (clés serveur : domaine sans objet ; IP du VPS inconnue). À faire en phase 8 ter. |
