# ANALYTICS — mesure d'audience de la landing Raijin Shield

Périmètre : **landing Astro uniquement** (`apps/landing`). L'app `apps/web` n'embarque pas GA4 : ses mesures restent
internes (`ProductEvent`, `DailyMetric`, écran Acquisition de l'admin). Références : PROMPT.md §4.6, ARCHITECTURE.md §14.10,
contrats `libs/shared/contracts/src/lib/analytics/ga4.ts`.

## 1. Configuration (variables publiques lues au build, `astro:env`)

| Variable | Rôle | Vide ou invalide |
|---|---|---|
| `GA4_MEASUREMENT_ID` | Flux web GA4 (`G-XXXXXXX`, motif `^G-[A-Z0-9]{4,20}$`) | ni GA4, ni bannière, ni lien « Gérer les cookies » |
| `GOOGLE_SITE_VERIFICATION` | `<meta name="google-site-verification">` (propriété « préfixe d'URL ») | pas de meta (inutile avec une propriété de domaine DNS) |
| `APP_URL` | Base des liens vers l'app (`appHref(APP_ROUTES.inscription)` → `/compte/inscription` ; aussi `connexion` → `/compte/connexion`, `analyse` → `/analyse`) et de l'analyse d'un token (`appAnalyseHref(mint)` → `/analyse/<mint>`, mint validé en base58 puis encodé ; action du formulaire du hero) | `https://app.raijinshield.com` |

Les variables sont lues dans l'environnement du processus de build (`astro build`, lancé depuis `apps/landing`) : le
script de déploiement doit les exporter. Rien n'est secret ici.

## 2. Consentement (CNIL, Consent Mode v2 « basique »)

- **Avant tout choix, aucun script Google n'est chargé** : ni `gtag.js`, ni `dataLayer`, ni ping sans cookie.
- Bannière maison `components/consent/ConsentBanner.astro`, en tête du `<body>` : bottom sheet sous 768 px, encart en
  bas à gauche au-delà. « Tout refuser » et « Tout accepter » ont **exactement le même style** (aucune couleur de marque,
  aucune case précochée). « Personnaliser » ouvre deux catégories : « Strictement nécessaires » (toujours actifs : le
  cookie de choix) et « Mesure d'audience » (interrupteur éteint par défaut), puis « Enregistrer mes choix ».
- Accessibilité : `role="dialog"` non modal, titre et description reliés (`aria-labelledby`, `aria-describedby`),
  cibles ≥ 44 px, interrupteur `role="switch"` avec `<label>`. À la première visite, la bannière ne vole pas le focus
  (elle est le premier élément tabulable). Rouverte par « Gérer les cookies », elle reçoit le focus et le rend au bouton
  à la fermeture. **Échap ne vaut jamais acceptation** : sans choix, il ne fait rien ; avec un choix, il ferme sans le
  modifier.
- Choix mémorisé dans `rj_consent` = `v1.granted|denied.<AAAA-MM-JJ>` : cookie de premier niveau, `Max-Age` 182 jours,
  `Path=/`, `SameSite=Lax`, `Secure` en HTTPS. Une valeur illisible, d'une autre version (`CONSENT_VERSION`), datée dans
  le futur ou de plus de 182 jours est ignorée : la bannière est reproposée.
- « Tout accepter » : `gtag('consent','default', tout denied)`, `update analytics_storage: granted` (`ad_storage`,
  `ad_user_data`, `ad_personalization` restent `denied`), `gtag('config', id, { allow_google_signals: false,
  allow_ad_personalization_signals: false })`, puis injection de `https://www.googletagmanager.com/gtag/js?id=…`.
- Retrait (refus après acceptation) : `ga-disable-<id>`, `consent update analytics_storage: denied`, suppression des
  cookies `_ga`, `_ga_*`, `_gid` sur l'hôte et ses domaines parents, `rj_attr` repassé en `sessionStorage`.
- Lien « Gérer les cookies » : `components/consent/ManageCookiesButton.astro` (pied de page `SiteFooter.astro`).
- CSP : aucun script inline. Le seul script est le module externe `/_astro/*.js` (`src/scripts/analytics-boot.ts`,
  ≈ 3 ko gzip, `assetsInlineLimit: 0`). CSP cible (phase 8, Traefik) : `script-src 'self' https://www.googletagmanager.com` ;
  `connect-src` et `img-src` : `'self' https://*.google-analytics.com https://*.analytics.google.com
  https://www.googletagmanager.com` ; `font-src 'self'`.
- Polices auto-hébergées (`src/styles/fonts.css`, paquets `@fontsource/*`, Inter 400 et Space Grotesk 600 préchargées) :
  aucune requête vers Google Fonts.

## 3. Événements GA4 (liste fermée, snake_case)

| Événement | Paramètres | Déclencheur réel (phase 7) | Événement clé |
|---|---|---|---|
| `analyse_demo_lancee` | — | envoi **valide** du champ d'analyse du hero (`lib/analyse-form.ts`), juste avant la navigation vers `{APP_URL}/analyse/<mint>` ; rien sur une saisie invalide. Le mint n'est jamais transmis à GA4 | |
| `analyse_demo_resultat` | `verdict` : `safe` · `warn` · `danger` | clic sur « Lancer la démonstration » (`lib/demo/demo-island.ts`) : verdict de l'**analyse de démonstration** (token fictif « Exemple », calculé au build). Le verdict d'une vraie analyse est rendu par l'app, sans GA4 : il est mesuré en interne (`ProductEvent`, attribution `rj_lp`) | |
| `cta_essai_clic` | `emplacement` : `header` · `hero` · `tarifs` · `faq` · `final` · `guide` | clic sur un CTA d'essai Pro (« Essayer gratuitement », « Essayer Pro gratuitement », « Créer mon compte » du hero), déclaratif `data-track` | oui |
| `inscription_debut` | `emplacement` (idem) | clic sur « Créer un compte gratuit » (carte Gratuit des tarifs), déclaratif | oui |
| `voir_tarifs` | — | clic sur un lien vers `/tarifs` (en-tête, pied de page, accueil) et affichage de la page Tarifs (`[data-track-view="voir_tarifs"]`, envoyé au démarrage si le consentement est déjà donné) | |
| `guide_lu` | `slug` | défilement au-delà de 60 % de l'article d'un guide, une fois par page vue (`lib/guide-read.ts`) | |
| `faq_ouverte` | `faq_id` (identifiant de la question, ex. `essai-pro`) | ouverture d'un `<details data-faq-id>` (accueil, `/faq`, `/tarifs`) : événement `toggle` écouté en capture, rien à la fermeture (`lib/analytics/page-events.ts`) | |

L'emplacement `verdicts` reste dans la liste des contrats mais n'est porté par aucun bouton : la section des verdicts
n'a pas de CTA (un seul bouton principal par écran).

Aucune donnée personnelle, aucune adresse de wallet ni mint saisi dans les paramètres.

### Envoyer un événement

- Depuis un script ou un îlot : `import { track } from '../lib/analytics'` puis `track('guide_lu', { slug })`. Signature
  typée par `Ga4EventName` / `Ga4EventParams` (import de types seulement, aucun Zod). **No-op** sans consentement ou sans
  GA4 chargé : rien n'est envoyé ni mis en file ; renvoie `true` si l'événement est parti.
- Sans JavaScript de page (déclaratif) : `data-track="cta_essai_clic" data-track-emplacement="hero"` (les `_` du nom de
  paramètre deviennent `-` : `data-track-faq-id`). Clics délégués en phase de capture ; nom hors liste ou paramètre
  invalide (`^[a-z0-9][a-z0-9_-]{0,63}$`, emplacement et verdict dans leur liste) : rien n'est envoyé.

## 4. Attribution de première visite (landing → app → inscription)

- Relevé au premier chargement : `utm_source`, `utm_medium`, `utm_campaign`, référent **externe** réduit à origine +
  chemin (ni requête ni ancre), page d'arrivée (chemin). Rien n'est retenu sans UTM ni référent externe (même règle que
  `AttributionTracker` de l'app). Valeurs bornées comme `signupAttributionSchema` (200 caractères, URL 2048, chemin 512,
  aucun caractère de contrôle, http(s) seulement) ; l'app et l'API revalident.
- Premier contact : une attribution déjà retenue n'est jamais remplacée.
- Stockage : `sessionStorage` (`rj.attribution`, onglet courant) **sans consentement** ; cookie de premier niveau
  `rj_attr` (JSON, 90 jours, `SameSite=Lax`, `Secure`) **après acceptation** de la mesure d'audience. Refus ou retrait :
  cookie supprimé, retour en session.
- Transmission à l'app : au démarrage, chaque `<a data-app-link href={appHref(…)}>` (inscription, connexion, analyse) est complété avec
  `ATTRIBUTION_QUERY_PARAMS` : `utm_source`, `utm_medium`, `utm_campaign`, `rj_ref` (provenance), `rj_lp` (page
  d'arrivée). Un paramètre déjà présent dans le lien n'est pas écrasé. Le champ d'analyse ajoute les mêmes paramètres à
  `{APP_URL}/analyse/<mint>` (`decorateAppUrl`) ; sans JS, le formulaire envoie `GET {APP_URL}/analyse?mint=…` et
  l'app redirige vers `/analyse/<mint>` en conservant l'attribution.
- Alignement : `apps/landing/src/lib/analytics/constants.spec.ts` compare les constantes de la landing à celles des
  contrats (événements, emplacements, cookies, durées, paramètres) et valide un relevé avec `signupAttributionSchema`.

## 5. Conversions : écart assumé

L'inscription confirmée et l'abonnement ont lieu dans l'app, **sans GA4** : ils sont mesurés en interne et reliés aux
sources (UTM, `rj_ref`, `rj_lp`) par l'écran Acquisition de l'admin. Dans GA4, seuls `inscription_debut` et
`cta_essai_clic` sont marqués comme événements clés. Le Measurement Protocol est écarté (il exigerait un secret et un
identifiant GA transmis à l'app).

## 6. Fichiers

- `apps/landing/src/lib/analytics/` : `constants.ts`, `cookies.ts`, `consent.ts`, `ga4.ts`, `track.ts`,
  `attribution.ts`, `banner.ts`, `boot.ts`, `index.ts` (API publique) ; tests `*.spec.ts` (jsdom).
- `apps/landing/src/components/consent/` : `ConsentBanner.astro`, `ManageCookiesButton.astro` ;
  `components/SiteFooter.astro` ; `layouts/Base.astro` (meta de vérification, bannière, script) ; `lib/app-url.ts`
  (`appHref`, `appAnalyseHref`), `lib/app-links.ts` (`buildAnalyseUrl`, sans `astro:env`).
- Phase 7 : `lib/analytics/page-events.ts` (`faq_ouverte`, `voir_tarifs` à l'affichage), `lib/analyse-form.ts` +
  `scripts/analyse-form.ts` (champ du hero), `lib/demo/demo-island.ts` + `scripts/demo.ts` (démonstration),
  `lib/guide-read.ts` + `scripts/guide-read.ts` (`guide_lu`). Budget mesuré par `src/dist.spec.ts` : JS ≤ 12 ko gzip
  par page (≈ 6 ko sur l'accueil, ≈ 3 ko ailleurs).
- Tests : aucun script Google avant acceptation, Échap sans effet, refus respecté et mémorisé, expiration à 182 jours,
  retrait (cookies `_ga` supprimés), `track` no-op sans consentement, suivi déclaratif filtré, attribution (session puis
  cookie, premier contact, valeurs hostiles, décoration des liens).
