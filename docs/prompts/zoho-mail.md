Utilise l'agent ops-chrome pour créer la messagerie Zoho de Raijin Shield sur le domaine raijinshield.com, avec une signature sur le modèle de celle de MyTradingCoach.

CONTEXTE
- Le domaine raijinshield.com est chez OVH. Je suis connecté dans Chrome à mon espace OVH et à mon NOUVEAU compte Zoho dédié à Raijin (plan Forever Free).
- J'ai un AUTRE compte Zoho pour MyTradingCoach (domaine mytradingcoach.app) : n'y touche jamais, ni à sa zone DNS chez OVH. Si l'onglet Zoho affiche l'organisation MTC ou le domaine mytradingcoach.app, arrête-toi et demande-moi de changer de compte.

OBJECTIF
- Boîte principale : contact@raijinshield.com
- Alias gratuits : support@raijinshield.com (clients) et admin@raijinshield.com (inscriptions aux services : Stripe, Google, Resend…) → même boîte
- Envoi et réception fonctionnels, bonne délivrabilité (SPF, DKIM, DMARC), compatibles avec Resend (qui enverra plus tard les e-mails automatiques depuis noreply@)
- Signature professionnelle Raijin Shield, sur la même structure que celle de MTC

ÉTAPES

1. Liste mes onglets, puis travaille dans un nouvel onglet. Ouvre la console d'administration Zoho Mail du compte Raijin. Note le centre de données utilisé (zoho.eu ou zoho.com) : toutes les valeurs DNS viendront de ce que Zoho affiche. N'invente aucune valeur.

2. Ajoute le domaine raijinshield.com. Récupère l'enregistrement TXT de vérification affiché par Zoho.

3. Dans OVH > Noms de domaine > raijinshield.com > Zone DNS :
   - Avant toute modification, note dans docs/OPS-LOG.md tous les enregistrements MX, TXT (SPF) et CNAME existants.
   - Ajoute le TXT de vérification.
   - Attends la propagation, puis valide le domaine dans Zoho.

4. Crée la boîte contact@raijinshield.com. Si Zoho propose d'en faire l'adresse principale du compte administrateur, accepte : pas besoin d'un 2e utilisateur. Si un mot de passe doit être saisi pour un nouvel utilisateur, arrête-toi et laisse-moi le taper.

5. Ajoute les alias support@raijinshield.com et admin@raijinshield.com sur cette boîte.

6. DNS chez OVH, avec les valeurs exactes affichées par Zoho :
   - MX : remplace les MX par défaut d'OVH (mx*.mail.ovh.net) par les MX Zoho, avec leurs priorités.
   - SPF : un SEUL enregistrement TXT « v=spf1 … ~all » à la racine, qui inclut Zoho. S'il en existe déjà un, fusionne au lieu d'en créer un second. Ne touche pas aux sous-domaines de Resend (send.raijinshield.com, resend._domainkey) s'ils existent.
   - DKIM : génère la clé dans Zoho (sélecteur proposé par Zoho), ajoute le TXT chez OVH, puis vérifie-le dans Zoho.
   - DMARC : TXT sur _dmarc.raijinshield.com = « v=DMARC1; p=none; rua=mailto:contact@raijinshield.com; fo=1 ». On passera à p=quarantine après 2 semaines sans problème.

7. Dans Zoho, vérifie que MX, SPF et DKIM sont tous au vert. Si la propagation n'est pas finie, attends et revérifie (jusqu'à 30 min), sans modifier d'autres enregistrements.

8. Signature, sur le modèle de celle de MyTradingCoach :

   a) MODÈLE MTC, en lecture seule :
      - Si docs/REFERENCES.md contient MTC_REPO, cherche dans ce dépôt une signature ou un gabarit d'e-mail (fichiers *signature*, templates d'e-mails, dossiers emails/) et analyse sa structure.
      - Sinon, demande-moi de te coller le HTML de la signature MTC (Zoho MTC > Paramètres > Signature > mode HTML) ou une capture d'écran. Ne te connecte jamais au compte Zoho de MTC toi-même.
      - Reproduis la MÊME structure (disposition, ordre des éléments, tailles, séparateur, liens) en l'adaptant à la charte Raijin Shield (libs/brand/BRAND.md). Ne copie aucun texte, logo ni couleur de MTC.

   b) CONTENU :
      - Logo : libs/brand/logos/raijin-mark-color.svg exporté en PNG 2x (96×96 px, affiché en 48×48), fond transparent. Pas de SVG : les clients mail l'affichent mal.
        Héberge-le via l'option d'image du créateur de signature Zoho. Plus tard, une fois la landing en ligne, il sera remplacé par https://raijinshield.com/email/logo-96.png.
      - Nom : « Raijin Shield » (Space Grotesk si disponible, sinon Arial/Helvetica, gras).
      - Ligne 2 : « L'équipe Raijin » · « Le bouclier anti-rug des memecoins Solana ».
      - Liens : raijinshield.com · contact@raijinshield.com · X / Telegram seulement s'ils existent déjà, sinon rien.
      - Petite mention en gris : « Analyses de sécurité à titre informatif — pas un conseil en investissement. »

   c) STYLE, compatible avec tous les clients mail :
      - HTML en tableaux, styles en ligne, largeur max 480 px, aucune police externe obligatoire, aucun script.
      - Couleurs : texte principal #0b1017 ; accent en jaune foncé #7a5d00 (jamais le jaune #facc15 en texte sur fond blanc, illisible) ; gris #526073 pour la mention ; filet #facc15 de 2 px comme séparateur.
      - Lisible en mode sombre (Apple Mail, Gmail) : vérifie l'aperçu.
      - Mobile : rien de plus large que 320 px sans retour à la ligne.

   d) MISE EN PLACE :
      - Enregistre le HTML final dans libs/brand/email/signature.html, la version texte dans libs/brand/email/signature.txt et le logo PNG dans libs/brand/email/logo-96.png, pour les réutiliser dans les e-mails de l'app.
      - Colle-la dans Zoho Raijin > Paramètres > Signatures, associe-la à contact@ et support@, active-la pour les nouveaux messages ET les réponses.
      - Nom d'expéditeur : « Raijin Shield ».

9. Dossiers et filtres :
   - « Stripe » : expéditeurs se terminant par stripe.com
   - « Inscriptions » : objet contenant « Nouvel inscrit »
   - « Alertes système » : expéditeur noreply@raijinshield.com
   - « Support » : destinataire support@raijinshield.com
   - « Comptes » : destinataire admin@raijinshield.com (inscriptions, codes de vérification, factures des services)

10. Tests :
    - Demande-moi d'envoyer un e-mail depuis mon Gmail vers contact@, puis support@, puis admin@. Vérifie qu'ils arrivent au bon endroit.
    - Réponds depuis contact@ et demande-moi de confirmer que la réponse est arrivée dans ma boîte de réception (pas dans les spams) et que la signature s'affiche bien, sur ordinateur et sur iPhone, en mode clair et en mode sombre.
    - Corrige la signature si je signale un défaut, puis refais un test.

11. Traçabilité :
    - docs/OPS-LOG.md : chaque enregistrement DNS ajouté ou modifié (ancienne et nouvelle valeur) et chaque réglage Zoho.
    - docs/COMPTES.md : coche la ligne Zoho.
    - docs/PROGRESS.md, section « À brancher » : ce qui reste (par exemple « DMARC p=quarantine dans 2 semaines », « remplacer le logo de la signature par l'URL raijinshield.com après mise en ligne »).
    - Commit sur dev : « chore(ops): messagerie Zoho raijinshield.com + signature ».

INTERDITS
- Aucun paiement, aucun passage à une offre payante Zoho, aucune acceptation de CGU à ma place.
- Aucune suppression d'enregistrement DNS autre que les MX par défaut d'OVH sur raijinshield.com.
- Rien sur mytradingcoach.app ni sur l'organisation Zoho de MTC (lecture du dépôt MTC uniquement, si MTC_REPO est défini).
- Connexion, code 2FA ou captcha : arrête-toi et demande-moi.
- Ne copie ni n'affiche aucun mot de passe ni code de sécurité.

À la fin, résume en 6 lignes : ce qui est en place, l'état des vérifications (MX, SPF, DKIM, DMARC), où est la signature et ce qui reste à faire.
