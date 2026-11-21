# Feuille de route

## V0 — Fondations (ce dépôt)
- [x] Cadre : CLAUDE.md, agents, règles de sécurité
- [x] Schéma Supabase + RLS + cron
- [x] Edge Function `scan-tokens` + logique pure testée
- [x] Squelette Angular 22 + Tailwind 4 : connexion e-mail + mot de passe (+ mot de passe oublié), liste des opportunités, copie d'adresse sécurisée
- [ ] `bootstrap.sh` exécuté, premier `pnpm build` vert
- [ ] Premier déploiement (Supabase + Vercel)

## V1 — Utilisable au quotidien
- [ ] Filtres persistés (score min, MC, zone uniquement)
- [ ] Fiche token : graphique des bougies avec niveaux Fib
- [ ] Watchlist (la table et la RLS existent déjà)
- [ ] Badge « nouveau » et tri par date de détection

## V2 — Mesurer avant d'optimiser
- [ ] Écran « Performance des signaux » : taux de x2 à 24 h/72 h par tranche de score
- [ ] Recalibrage des poids par `scanner-quant`
- [ ] Alertes (push PWA ou Telegram via Edge Function)

## V3 — Plus tard
- [ ] PWA installable sur iPhone
- [ ] Narratifs détectés automatiquement (mots-clés qui montent dans les nouveaux tokens)
