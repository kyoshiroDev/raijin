---
title: "Honeypot : comment le détecter"
heading: "Honeypot sur Solana : comment détecter un token qu'on ne peut pas revendre"
description: "Freeze, frais de transfert, transfer hook, absence de route : comment fonctionne un honeypot sur Solana et comment le repérer avec un simple devis de vente."
publishedAt: 2026-11-23
updatedAt: 2026-11-23
readingMinutes: 6
related:
  - mint-authority
  - rug-pull-solana
sources:
  - label: "Solana Program Library : programme Token (comptes gelés)"
    url: https://spl.solana.com/token
  - label: "Solana Program Library : extensions Token-2022 (frais de transfert, transfer hook)"
    url: https://spl.solana.com/token-2022/extensions
  - label: "Documentation développeurs de Jupiter (API de devis)"
    url: https://dev.jup.ag
  - label: "RugCheck, rapports de risque des tokens Solana"
    url: https://rugcheck.xyz
---

Un **honeypot** (pot de miel) est un token que l'on peut obtenir sans difficulté, mais qu'on ne peut **pas revendre**,
ou seulement en perdant presque tout. Le graphique monte, les transactions entrantes passent, et c'est seulement au
moment de revendre que le piège se referme.

Sur Solana, il n'existe pas un mécanisme unique, mais plusieurs. Ils ont un point commun : ils se voient **avant**, si
l'on regarde au bon endroit.

## Les mécanismes de honeypot sur Solana

### Le gel des comptes (autorité de freeze)

Si l'autorité de freeze du token est active, son détenteur peut geler ton compte de tokens juste après ton swap. Tes
tokens restent visibles dans ton wallet, mais tu ne peux plus les envoyer ni les vendre. C'est le cas le plus simple à
repérer : il suffit de lire le compte de mint. Voir
[Mint authority : c'est quoi ?](/guides/mint-authority).

### Les frais de transfert confiscatoires (Token-2022)

L'extension **transfer fee** de Token-2022 prélève un pourcentage à chaque transfert. Réglée très haut, elle rend la
revente absurde : tu récupères une fraction de ce que tu as mis. Les frais sont lisibles dans le compte de mint.
Raijin signale tout frais de transfert, et considère qu'à partir de 50 % la revente est impossible en pratique.

### Le transfer hook

Avec l'extension **transfer hook**, chaque transfert appelle un programme choisi par le créateur. Ce programme peut
laisser passer les transactions entrantes et refuser les ventes, ou changer de comportement plus tard. Raijin le
signale toujours comme un point d'attention : son effet ne se lit pas dans le compte de mint.

### Le token non transférable et le délégué permanent

L'extension **non transférable** interdit tout transfert. Le **délégué permanent** permet à une adresse de reprendre
ou de brûler les tokens de n'importe quel holder. Dans les deux cas, ce que tu détiens ne t'appartient pas vraiment.

### L'absence de route de vente

Enfin, le cas le plus brutal : il n'existe tout simplement aucun chemin pour revendre le token contre du SOL ou de
l'USDC, parce que la liquidité est absente, retirée ou piégée.

## Le test qui révèle presque tout : le devis de vente

La méthode la plus directe consiste à demander à un agrégateur de swap comme Jupiter un **devis** pour revendre un
petit montant du token. Un devis est une simple question (« combien recevrais-je ? ») : il ne demande **aucune
signature** et **n'exécute aucune transaction**.

Le devis apporte trois informations :

1. **Une route existe-t-elle ?** Sans route, la revente est probablement impossible : signal critique.
2. **La taxe implicite.** On compare ce que le devis rend avec la valeur de marché du montant vendu, hors impact
   prix. Un écart important trahit une taxe cachée. Raijin signale une taxe implicite au-delà de 10 % et la traite
   comme critique à partir de 50 %.
3. **L'impact prix.** Si revendre un petit montant fait déjà bouger le prix de plus de 5 %, la liquidité est trop
   mince pour sortir sans perte.

## Les limites du test

- **Un devis n'est pas une exécution.** Un transfer hook peut accepter le devis et refuser la transaction réelle.
- **Le comportement peut changer.** Un hook ou une autorité encore active peuvent être utilisés plus tard : une revente
  possible aujourd'hui ne l'est peut-être plus demain. C'est pour cela que Raijin propose de suivre un token et
  t'alerte si son verdict se dégrade.
- **Une source peut manquer.** Si l'agrégateur ne répond pas, le contrôle est marqué indisponible, jamais réussi.

## En résumé

| Vérification | Ce qu'elle détecte |
|---|---|
| Autorité de freeze | Gel de ton compte après le swap |
| Extensions Token-2022 | Frais de transfert, hook, non transférable, délégué permanent |
| Devis de vente | Absence de route, taxe cachée, impact prix |
| Liquidité | Pool vide ou trop mince pour revendre |

Raijin Shield fait ces vérifications dans une seule analyse, avec la source de chaque contrôle. Pour la vue
d'ensemble des autres arnaques, lis [Comment repérer un rug pull sur Solana](/guides/rug-pull-solana). Les memecoins
restent extrêmement risqués : ce guide n'est pas un conseil en investissement.
