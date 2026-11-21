# Raijin Shield — charte graphique

**Raijin Shield, le paratonnerre des memecoins Solana.**
Raijin est le dieu japonais du tonnerre. La marque reprend l'idée du paratonnerre : l'éclair (le rug, le dump, l'arnaque) va frapper, Raijin le détecte et te protège avant. C'est un outil de **sécurité et de données**, pas un signal d'achat.

Promesse : *« Vérifie avant de signer. »*
Accroche courte : *« Le bouclier anti-rug des memecoins Solana. »*

## Nom de la marque

- **Nom officiel : Raijin Shield.** Il est utilisé sur la landing (titre, balises SEO, Open Graph), dans le logotype, les mentions légales, Stripe, les reçus et le domaine `raijinshield.com`.
- **Nom court : Raijin.** Il est utilisé dans l'app, les e-mails, les notifications et le nom de l'icône sur l'écran d'accueil (12 caractères maximum sous l'icône). On dit « Raijin a détecté… », « ton essai Raijin Pro ».
- Première mention dans un texte : « Raijin Shield », ensuite « Raijin ». Jamais « RaijinShield » collé, jamais « Raijin-Shield ».
- Dans le logotype, « Raijin » est en Space Grotesk Bold, avec « SHIELD » en petites capitales très espacées en dessous, couleur `thunder` sur fond sombre.


## Le logo

Le symbole est un **bouclier jaune éclair percé d'un éclair** : protection et vitesse en un seul geste. Il est dessiné d'une seule pièce (l'éclair est découpé dans le bouclier). Il fonctionne donc en une seule couleur, du favicon de 16px au panneau de landing.

| Fichier | Usage |
| --- | --- |
| `raijin-mark-color.svg` | Symbole couleur (bouclier `thunder`, éclair `base`). Usage par défaut. |
| `raijin-mark.svg` | Symbole monochrome en `currentColor` : favicon, tampon, impression une couleur. |
| `raijin-wordmark-color.svg` | Logotype complet « Raijin SHIELD » : symbole, « Raijin » en `ink` clair, « SHIELD » en `thunder`. Uniquement sur fond sombre. |
| `raijin-wordmark.svg` | Logotype complet « Raijin SHIELD » en `currentColor`. Sur fond clair, mettre `color: var(--ink)`. |
| `raijin-app-icon.svg` | Icône d'app iOS/PWA (fond `base`, coins 112/512). Exporter en 180, 192 et 512px. |

Règles :
- Zone de protection autour du logo : la moitié de la hauteur du symbole.
- Taille minimale : symbole 16px, logotype 96px de large.
- Ne pas déformer, incliner ni ombrer le logo. Pas de dégradé, pas de contour ajouté.
- Le jaune ne sert jamais de couleur de texte sur fond clair. Sur fond clair, utiliser la version monochrome en `ink`.
- Le logotype utilise Space Grotesk (Bold pour « Raijin », SemiBold espacé pour « SHIELD »). Pour un rendu identique partout, vectoriser le texte avant impression.

## Couleurs

L'identité est **sombre par défaut** (thème « Nuit »). Le thème « Jour » existe pour les e-mails et les documents imprimés.

- **Thunder `#facc15`** est la seule couleur de marque. On la réserve aux moments clés : logo, bouton principal (une fois par écran), anneau de focus. Si tout est jaune, plus rien ne ressort.
- **Base / surface / surface-raised** forment la profondeur. On empile `base` → `surface` → `surface-raised` au lieu d'ajouter des ombres partout.
- **Les verdicts** (`safe`, `warn`, `danger`) sont fonctionnels, jamais décoratifs. Un verdict s'affiche **toujours avec une icône et un mot** (« Sain », « Prudence », « Danger »), jamais avec la couleur seule (daltonisme).
- `info` sert aux liens externes et à l'aide.
- Texte sur jaune : `on-thunder` (presque noir). Jamais de blanc sur jaune.

Tous les couples texte/fond listés dans les notes des tokens dépassent un contraste de 4,5:1 dans les deux thèmes.

## Typographie

Trois familles Google Fonts, chargées en `display=swap` :

- **Space Grotesk** (titres) : géométrique et un peu technique, avec du caractère.
- **Inter** (texte) : lisible en petit, sur mobile.
- **JetBrains Mono** (chiffres) : market cap, liquidité, adresses, pourcentages. On active `font-variant-numeric: tabular-nums` pour que les colonnes s'alignent.

Une adresse de token s'affiche toujours en mono, tronquée au milieu (`7xKX…9fQp`) avec un bouton copier.

## Espacement et formes

Grille de 4px. Cartes : `space-4` de padding sur mobile, `space-6` sur desktop, coins `radius-lg`. Boutons et champs : `radius-md`. Badges de verdict : `radius-sm`. Pastilles et jauges : `radius-full`.

Le halo `shadow-glow` est réservé au bouton d'action principal au survol. C'est la signature « éclair » de l'interface, à ne pas utiliser ailleurs.

## Iconographie

Icônes au trait de 1,75px, coins arrondis, en `currentColor`, grille de 24px. Lucide est compatible avec ce style. Icônes de verdict : bouclier-check (`safe`), triangle (`warn`), octogone-croix (`danger`).

## Ton et contenus

Raijin parle comme un **ami expert en sécurité** : direct, factuel, sans jargon inutile, en tutoiement.

À faire :
- Dire ce qu'on a vérifié et ce qu'on n'a pas pu vérifier : « Mint désactivé · LP verrouillée 92 % · 3 wallets détiennent 41 % ».
- Donner des faits et des niveaux de risque.
- Rappeler que le risque zéro n'existe pas.

À ne jamais faire :
- Promettre un gain, afficher « x10 », « moon », « gem », ou des fusées et des emojis d'argent.
- Écrire « achète », « opportunité », « signal d'achat ». Raijin informe, il ne recommande pas d'investissement.
- Créer de l'urgence (« Dépêche-toi », « Dernière chance »).

Exemples :
- ✅ « Danger : l'autorité de mint est encore active. Le créateur peut imprimer des tokens à volonté. »
- ✅ « Prudence : 62 % de l'offre est dans 5 wallets. »
- ❌ « Ce token va exploser 🚀 »

Mention légale à afficher sur la landing et dans l'app : *« Raijin Shield fournit des analyses de sécurité à titre informatif. Ce n'est pas un conseil en investissement. Les memecoins sont extrêmement risqués : ne mise que ce que tu peux perdre. »*

## Mise en œuvre (Tailwind 4)

Les tokens se déclarent dans `@theme` (CSS-first). Exemple : `--color-thunder: #facc15;` puis `bg-thunder text-on-thunder`. La landing Astro et l'app Angular partagent le même fichier de tokens.

## Mascotte : Rai, le gardien

Rai est un petit **super-héros gardien** : casque avec une crête en éclair et deux petites cornes (clin d'œil au dieu Raijin), visière jaune, éclair sur la poitrine, cape doublée de jaune et bouclier Raijin au bras. Il protège : il rassure, il bloque le rug, il célèbre quand tout va bien. Il ne fait jamais de hype. Trois poses : héros (bouclier en avant), alerte (bouclier levé contre un éclair rouge), bravo (pouce levé). Une apparition par écran maximum, jamais à la place d'un verdict, et jamais avec des pièces ou des fusées.
