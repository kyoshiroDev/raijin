---
title: Comment repérer un rug pull sur Solana
heading: Comment repérer un rug pull sur Solana avant de signer
description: "Retrait de liquidité, mint infini, freeze, dump des wallets du créateur : les signaux techniques d'un rug pull sur Solana et comment les vérifier soi-même."
publishedAt: 2026-11-23
updatedAt: 2026-11-23
readingMinutes: 7
related:
  - mint-authority
  - honeypot-solana
sources:
  - label: "Solana Program Library : programme Token (autorités de mint et de freeze)"
    url: https://spl.solana.com/token
  - label: "Solana Program Library : extensions Token-2022"
    url: https://spl.solana.com/token-2022/extensions
  - label: "Metaplex : programme Token Metadata (métadonnées modifiables)"
    url: https://developers.metaplex.com/token-metadata
  - label: "Documentation DexScreener (paires, liquidité, âge du pool)"
    url: https://docs.dexscreener.com
  - label: "RugCheck, rapports de risque des tokens Solana"
    url: https://rugcheck.xyz
---

Un **rug pull** (« tirer le tapis ») désigne le moment où les personnes qui contrôlent un token récupèrent la valeur
qui s'y trouve et laissent les autres holders avec des tokens invendables ou sans valeur. Sur Solana, créer un token
prend quelques minutes et coûte quelques centimes : il en apparaît des milliers chaque jour, et une partie est conçue
dès le départ pour cela.

La bonne nouvelle, c'est que la plupart des rugs laissent des **traces techniques visibles avant**. Elles sont
publiques, sur la blockchain et sur les agrégateurs de marché. Ce guide les passe en revue une par une.

## Les quatre grandes familles de rug pull

### 1. Le retrait de liquidité

Pour qu'un token s'échange, quelqu'un dépose dans un pool (Raydium, Orca, Meteora, pump.fun…) une paire de
liquidité, par exemple le token contre du SOL. En échange, il reçoit des **jetons LP** qui représentent sa part du
pool. Tant qu'il les garde, il peut retirer la liquidité à tout moment. S'il le fait, le pool se vide : le prix
s'effondre et plus personne ne peut revendre à un prix normal.

Ce qui protège (en partie) : des jetons LP **brûlés** (envoyés vers une adresse sans clé) ou **verrouillés** dans un
contrat de blocage pour une durée connue.

### 2. Le mint infini (dilution)

Si l'**autorité de mint** du token est encore active, son détenteur peut créer de nouveaux tokens quand il veut, puis
les revendre dans le pool. Chaque token créé dilue ceux qui existent déjà. Le guide
[Mint authority : c'est quoi ?](/guides/mint-authority) explique ce mécanisme en détail.

### 3. Le blocage des reventes (honeypot)

Le token peut être obtenu, mais pas revendu : autorité de freeze qui gèle les comptes, frais de transfert
confiscatoires, programme appelé à chaque transfert qui refuse les ventes, absence de route de vente. On parle de
**honeypot** (pot de miel). Voir [Honeypot : comment le détecter](/guides/honeypot-solana).

### 4. Le dump des wallets proches du créateur

Ici, rien n'est techniquement bloqué : une poignée de wallets (souvent liés au créateur) détiennent une grande part du
supply et le revendent d'un coup. On parle parfois de **soft rug**. La répartition des holders est le premier indice.

## Les signaux à vérifier, un par un

Aucun signal isolé ne prouve une arnaque, et l'absence de signal ne prouve pas qu'un token est sans risque. Mais
plusieurs signaux ensemble dessinent un profil de risque clair.

| Signal | Pourquoi c'est important | Où le voir |
|---|---|---|
| Autorité de mint active | Création de tokens à volonté | Compte de mint (explorateur, RPC) |
| Autorité de freeze active | Gel possible de ton compte de tokens | Compte de mint |
| LP ni brûlée ni verrouillée | Liquidité retirable à tout moment | Agrégateurs, page du pool |
| Liquidité faible | Une petite vente fait chuter le prix | DexScreener, GeckoTerminal |
| Top 10 des holders très élevé | Quelques ventes pèsent lourd sur le prix | Liste des holders (hors LP) |
| Pas de devis de vente | Revente peut-être impossible | Agrégateur de swap (devis seul) |
| Métadonnées modifiables | Nom et logo peuvent changer (usurpation) | Compte de métadonnées Metaplex |
| Token ou pool très récent | Peu d'historique pour juger | Date de création du pool |
| Créateur aux tokens abandonnés | Comportement répété | Historique du wallet créateur |

### Les autorités du compte de mint

Sur Solana, chaque token est défini par un **compte de mint** qui porte deux champs : l'autorité de mint et
l'autorité de freeze. Un explorateur comme Solscan les affiche sur la page du token. « Aucune » (ou *None*) veut dire
que l'autorité a été révoquée : c'est définitif. Une adresse veut dire que quelqu'un garde la main.

Avec le programme **Token-2022**, d'autres extensions comptent : un **délégué permanent** peut déplacer ou brûler les
tokens de n'importe quel holder, des **frais de transfert** peuvent être prélevés à chaque mouvement, et un **transfer
hook** appelle un programme externe à chaque transfert.

### La liquidité et les jetons LP

Regarde le montant de liquidité du pool principal et la part des jetons LP brûlée ou verrouillée. Une liquidité
de quelques milliers de dollars ne supporte pas de vente importante. Raijin signale une liquidité inférieure à
10 000 $ et, pour les pools de moins de 30 jours, une part brûlée ou verrouillée inférieure à 50 %.

### La répartition des holders

Ouvre la liste des plus gros holders et **retire mentalement** les comptes qui ne sont pas des personnes : le pool de
liquidité lui-même, les programmes de verrouillage, les plateformes connues. Ce qui reste est la concentration réelle.
Raijin signale un top 10 au-delà de 30 % du supply et un wallet seul au-delà de 10 %.

### La revente

C'est le test le plus parlant : demander un **devis de vente** (token vers SOL ou USDC) à un agrégateur. Si aucune
route n'existe, ou si le devis révèle une taxe implicite élevée, la revente est compromise. Un devis ne demande aucune
signature et n'exécute rien.

## Ce qu'une vérification ne peut pas garantir

- **Le futur.** Une liquidité verrouillée 30 jours peut être retirée le 31e jour ; des holders peuvent vendre demain.
- **Les données manquantes.** Sur un token de quelques minutes, certaines sources n'ont encore rien. Un contrôle
  indisponible n'est pas un contrôle réussi.
- **La valeur du projet.** Ces contrôles décrivent un risque technique, pas l'intérêt ni le prix futur du token.

Les memecoins restent des actifs extrêmement risqués. Ne mise que ce que tu peux perdre.

## Vérifier un token avec Raijin Shield

Raijin Shield regroupe ces vérifications en une seule analyse : colle l'adresse du token (ou un lien DexScreener,
pump.fun ou Solscan) et tu obtiens les 9 contrôles, chacun avec son statut et sa source, puis un verdict **Sain**,
**Prudence** ou **Danger** calculé par des règles publiques, détaillées sur la page
[Comment ça marche](/comment-ca-marche). Un seul signal critique (mint actif, freeze actif, revente impossible ou
liquidité retirée) suffit pour le verdict Danger.
