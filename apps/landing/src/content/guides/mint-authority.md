---
title: "Mint authority : c'est quoi ?"
heading: "Mint authority et freeze authority : ce qu'elles permettent sur Solana"
description: "Autorité de mint, autorité de freeze, extensions Token-2022 : qui peut créer ou geler des tokens Solana, comment le vérifier et pourquoi la révocation compte."
publishedAt: 2026-11-23
updatedAt: 2026-11-23
readingMinutes: 6
related:
  - rug-pull-solana
  - honeypot-solana
sources:
  - label: "Solana Program Library : programme Token (mint, freeze, set-authority)"
    url: https://spl.solana.com/token
  - label: "Solana Program Library : extensions Token-2022"
    url: https://spl.solana.com/token-2022/extensions
  - label: "Solscan, explorateur de la blockchain Solana"
    url: https://solscan.io
---

Sur Solana, un token n'est pas un contrat écrit sur mesure comme sur Ethereum. Presque tous les tokens utilisent le
même programme standard, le **programme Token** de la Solana Program Library (ou sa version étendue, **Token-2022**).
Ce qui distingue un token d'un autre, c'est son **compte de mint** : son nombre de décimales, son supply et surtout
deux autorités.

## L'autorité de mint

L'**autorité de mint** (*mint authority*) est l'adresse autorisée à créer de nouvelles unités du token. Tant qu'elle
existe, son détenteur peut augmenter le supply quand il le veut, sans limite et sans prévenir.

Concrètement, pour un holder, cela veut dire :

- **dilution** : chaque nouveau token créé réduit la part de ceux qui existent déjà ;
- **revente massive** : les tokens fraîchement créés peuvent être vendus dans le pool, ce qui fait chuter le prix et
  vide la liquidité.

L'autorité de mint peut être **révoquée** : on la remplace par « aucune » (instruction `SetAuthority` avec une
nouvelle autorité vide). C'est **irréversible** : plus personne ne pourra jamais créer de nouveaux tokens. Le supply
devient fixe.

Pour un memecoin, une autorité de mint encore active est un signal critique. Dans Raijin Shield, il suffit à lui seul
pour le verdict **Danger**.

## L'autorité de freeze

L'**autorité de freeze** (*freeze authority*) peut **geler** n'importe quel compte de tokens de ce mint. Un compte gelé
ne peut plus envoyer ses tokens : impossible de les transférer ou de les revendre, tant que l'autorité ne les dégèle
pas.

C'est l'un des mécanismes classiques des honeypots : les nouveaux holders sont gelés, le créateur seul peut vendre.
Le guide [Honeypot : comment le détecter](/guides/honeypot-solana) détaille les autres.

Comme l'autorité de mint, elle peut être révoquée, de façon définitive.

### Le cas des émetteurs régulés

Certains tokens gardent volontairement une autorité de freeze : c'est le cas de stablecoins émis par des sociétés
régulées, qui doivent pouvoir bloquer des fonds sur décision de justice. Raijin connaît une courte liste de ces
émetteurs et signale alors l'autorité en **Prudence** au lieu de **Danger**. Pour un memecoin, aucune raison de ce
type n'existe.

## Les extensions Token-2022 à surveiller

Token-2022 ajoute des extensions optionnelles au compte de mint. Quatre d'entre elles changent le risque pour un
holder :

| Extension | Effet |
|---|---|
| Délégué permanent (*permanent delegate*) | Une adresse peut transférer ou brûler les tokens de n'importe quel holder |
| Frais de transfert (*transfer fee*) | Un pourcentage est prélevé à chaque transfert, revente comprise |
| Transfer hook | Un programme externe est appelé à chaque transfert et peut le refuser |
| Non transférable | Le token ne peut pas être déplacé du tout |

Raijin traite le délégué permanent comme une autorité de freeze active (signal critique), et les frais de transfert
de 50 % ou plus comme une revente impossible.

## Comment le vérifier soi-même

1. **Avec un explorateur.** Ouvre la page du token sur Solscan : les champs *Mint Authority* et *Freeze Authority*
   affichent soit une adresse, soit rien. Sur un token Token-2022, la section des extensions liste celles qui sont
   actives.
2. **En ligne de commande.** Avec l'outil officiel `spl-token`, la commande `spl-token display <adresse du mint>`
   affiche les autorités et les extensions.
3. **Avec Raijin Shield.** Les deux premiers des 9 contrôles portent exactement sur ces autorités, lues sur le RPC
   Solana via Helius, avec les extensions Token-2022.

## Ce que la révocation ne dit pas

Une autorité de mint et de freeze révoquées, c'est le minimum attendu, pas une garantie. La liquidité peut toujours
être retirée, et quelques wallets peuvent toujours détenir l'essentiel du supply. Le guide
[Comment repérer un rug pull sur Solana](/guides/rug-pull-solana) présente les autres vérifications à faire.

Aucune analyse ne remplace ton propre jugement, et ce n'est pas un conseil en investissement.
