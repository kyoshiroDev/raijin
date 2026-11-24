# États des écrans de l'app (phase 9, T4)

Matrice des états de chaque écran de `apps/web`. Règles (PROMPT.md §3, BRAND.md) :

- **Chargement** : skeleton à la forme du contenu (jamais un spinner seul ; le spinner n'existe que dans un bouton occupé).
- **Vide** : Rai bravo (`rj-empty-state`) + message utile + action quand il y en a une.
- **Erreur** : Rai alerte (`rj-error-state`) + message factuel + « Réessayer » (secondaire : l'écran garde son unique bouton jaune).
- **Une seule Rai par écran**, jamais à la place d'un verdict ; verdicts toujours icône + mot.
- **Hors ligne** (global) : bandeau « Tu es hors ligne. » en haut de l'écran (`apps/web/src/app/offline-banner.ts`, `@defer (on idle)`, hors bundle initial, `role="status"`) ; les requêtes échouent en `NETWORK_ERROR` (« Raijin ne répond pas. Vérifie ta connexion puis réessaie. ») et chaque écran affiche son état d'erreur. Le service worker précharge le JS, la CSS et les poses de Rai utilisées par les états vide et erreur (`ngsw-config.json`, groupe `mascot`) : les écrans déjà installés s'ouvrent hors ligne et l'état d'erreur garde sa Rai.
- **Non connecté** : `authGuard` / `verifiedEmailGuard` renvoient vers `/compte/connexion?redirect=…` ; si l'API est injoignable, les deux gardes laissent passer et l'écran montre son erreur avec « Réessayer » (plus de renvoi trompeur vers la connexion quand on est hors ligne).

Légende : ✔ présent · — sans objet.

| Écran | Chargement | Vide (Rai bravo) | Erreur (Rai alerte) | Quota / limite | Hors ligne | Non connecté |
|---|---|---|---|---|---|---|
| `/analyse` | `rj-analysis-loading` (bouclier qui scanne + 9 lignes en skeleton) | « Vérifie avant de signer » + liste des 9 contrôles | ✔ titre selon le code (introuvable, sources indisponibles, trop de demandes, Raijin ne répond pas) | carte « Quota du jour atteint » (horloge, sans Rai) + compte gratuit (visiteur) ou offre Pro (Gratuit) ; quota restant sur une ligne réservée | bandeau + erreur `NETWORK_ERROR` | autorisé (quota visiteur) |
| `/analyse/:mint` (résultat) | idem | — | idem | idem | idem | autorisé |
| `/t/:mint` | `rj-analysis-loading` « Chargement de l'analyse » | « Pas encore d'analyse récente » / « Adresse non reconnue » + « Analyser ce token » | ✔ | — | bandeau + erreur | public |
| `/suivis` | 9 skeletons (compteur + cartes/tableau) | « Aucun token suivi pour l'instant » + « Analyser un token » | ✔ | jauge `n / limite` ; à la limite, message et lien vers l'offre Pro ; suivis en pause « limite du plan » | bandeau + erreur | connexion (`verifiedEmailGuard`) ; e-mail non vérifié → « Vérifie ta boîte » |
| `/alertes` | 5 skeletons | « Aucune alerte pour l’instant » / « Aucune alerte avec ces filtres » | ✔ | historique 30 j (Gratuit) / 90 j (Pro) annoncé dans l'en-tête | bandeau + erreur | connexion (`authGuard`) |
| `/wallet` | skeleton du formulaire (accès), puis skeleton du résumé et des cartes (scan) | « Aucun token dans ce wallet » | ✔ trois cas : session, accès, scan | quota restant + carte « quota du jour atteint » ; plan Gratuit → carte « fait partie du plan Pro » | bandeau + erreur | carte « fait partie de Raijin Pro » + « Créer un compte » / « Se connecter » |
| `/compte` (profil, plan, notifications, sécurité, données) | 3 skeletons de cartes | — | ✔ « Tes données ne sont pas perdues » | — | bandeau + erreur | connexion (avec retour sur la section) |
| `/compte` : feuilles (mot de passe, suppression, export) | bouton occupé | — | message sous le champ (`role="alert"`) | — | message réseau sous le champ | — |
| Connexion, inscription, lien magique, mot de passe oublié / nouveau | bouton occupé | — | messages sous les champs + résumé `role="alert"` | limite d'essais (429) en message | message réseau | (écrans de visiteur, `guestGuard`) |
| Vérification d'e-mail, lien magique (vérification) | skeleton (cercle + titre) | — | Rai alerte « Lien expiré ou déjà utilisé » / « Connexion impossible » + renvoi | délai de renvoi (« Renvoyer dans n s ») | message réseau | — |
| `/abonnement` | 5 skeletons (plan + 2 offres) | — | ✔ (offres indisponibles) | — | bandeau + erreur | offres visiteur + « Créer un compte » |
| `/abonnement/succes` | « Confirmation en cours » (skeleton) | Rai bravo à la confirmation | ✔ erreur et délai dépassé (« Réessayer ») | — | bandeau + erreur | connexion |
| Simulation Checkout / portail | 2 skeletons | portail : « Aucun abonnement à gérer » | ✔ | — | bandeau + erreur | connexion |
| `/abonnement/fin-essai` | 4 skeletons | « Aucun essai Pro à résumer » | ✔ | récapitulatif + ce qui change en Gratuit | bandeau + erreur | connexion |
| `/abonnement/suivis` (choix des suivis à garder) | 3 skeletons | « Tous tes suivis restent actifs » | ✔ | sélection limitée à la limite Gratuit | bandeau + erreur | connexion (`verifiedEmailGuard`) |
| Bandeau d'essai (coque) | — (chunk `@defer`, compte en essai seulement) | — | — | jours restants | — | absent |
| Notifications push (`/compte?section=notifications`) | interrupteur occupé | — | message (refus du navigateur, push non configuré) | push réservé au Pro : explication + offre | message réseau | connexion |
| Admin × 9 (vue d'ensemble, trafic, SEO, acquisition, produit, revenus, essais, santé, utilisateurs) | `rj-admin-page-skeleton` (KPI + graphique + tableau) | tableaux : texte vide par tableau ; essais : `rj-empty-state` | ✔ « Impossible de charger cet écran » (`rj-admin-report-state`) ; rechargement : contenu à 60 % + `aria-busy` | santé : quotas des sources (jauges) | erreur + « Réessayer » (bandeau de l'app absent : coque admin) | 404 standard (non-admin) |
| Admin 2FA (activation, code, codes de secours, sécurité du compte) | activation : skeleton du QR | — | activation : ✔ ; code : messages sous le champ, Rai alerte quand la session a expiré | blocage après 5 essais (message) | erreur + « Réessayer » | 404 standard |
| 404 | — | Rai bravo « Cette page n'existe pas » + « Analyser un token » / « Mes suivis » | — | — | — | — |
| Maintenance | — | — | Rai alerte + « Réessayer » | — | — | — |

## Corrections de T4

- Bandeau « hors ligne » global (chunk différé) ; poses de Rai des états vide/erreur préchargées par le service worker.
- `verifiedEmailGuard` : API injoignable → l'écran s'affiche avec son erreur (comme `authGuard`), au lieu d'un renvoi vers la connexion (`/suivis`, `/abonnement/suivis`).
- Alertes : un token sans nom n'affiche plus deux fois son adresse tronquée (dont une hors police mono).
- Fin d'essai : « tokens Danger évités » → « tokens Danger repérés » (fait vérifiable, aucune promesse ; aligné sur l'e-mail J0).
- Phase 5 m4 : déjà corrigé (`4580605`, saisie au clavier) ; test ajouté pour le bouton « Coller ».

## Exceptions `px` / hex existantes (justifiées)

`libs/web/ui/src/styles/extras.css` (déclaration des tokens), `@keyframes` (décalages de 4 à 8 px et géométrie du bouclier de `shield-scan.ts`, grille SVG 64 px), media queries `1024px` (point de rupture `lg`, en JS et dans `bottom-sheet.ts`), QR factice des fixtures admin, `theme-color` de `index.html` (méta HTML, pas de variable possible). `email-sent.ts` : `&#8209;` (tiret insécable), faux positif. `static-verdict.css` (verdict statique de `/t`, §10.7) : icônes de verdict en `data:` SVG (tracés Lucide, masque coloré par `currentColor`, aucune couleur propre) et `1px`/`2px` de bordure et de contour, comme `border`/`outline-2` des utilitaires. Plus aucune valeur arbitraire dans `check-item.ts` (négatif `md:-mx-2` porté par le `<h3>`), `data-table.ts` (`max-h-128`) ni `otp-input.ts` (`tracking-widest`).

### Landing (`apps/landing/src/styles/landing.css`)

Toutes les longueurs passent par `var(--spacing)` (pas de 4 px de la charte) et les tokens de `libs/brand/tokens.css`, sauf : `1px` de bordure des cellules de tableau `.prose` (filet, comme l'utilitaire `border`) ; `inset: 0.2em` des barres de squelette de la démonstration (relatif au texte, suit chaque hauteur de ligne) ; `line-height: 1.7` de `.prose` (ratio sans unité) ; durées d'animation (`ms`/`s`), angles et facteurs d'échelle (pas des longueurs). Aucun code couleur.
