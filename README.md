# Raijin Shield — démarrage

1. **Renomme l'ancien projet** (sinon le dézippage l'écraserait) :
   ```bash
   cd "/home/kyoshiro/Documents/mes apps" && mv raijin raijin-old
   ```
2. **Dézippe** `raijin.zip` dans `"/home/kyoshiro/Documents/mes apps"` → tu obtiens le dossier `raijin/`.
3. **Une fois** : `gh auth login` (GitHub CLI) et, pour la configuration des services, l'extension **Claude in Chrome** connectée.
4. **Lance** :
   ```bash
   cd "/home/kyoshiro/Documents/mes apps/raijin"
   claude --chrome        # ou « claude » sans Chrome
   ```
5. Écris : **`démarre le projet`**

Ensuite : `reprends` pour continuer après une coupure, `statut` pour un point rapide.
Ce que tu dois faire toi-même apparaît en tête de `docs/PROGRESS.md` sous « ACTION REQUISE » (connexions, 2FA, clés secrètes à coller dans `.env`).
Comptes à créer quand tu veux : `docs/COMPTES.md` (le projet démarre sans).
