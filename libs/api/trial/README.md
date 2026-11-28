# api-trial

Essai Pro de 7 jours sans carte (phase 6, `docs/ARCHITECTURE.md` §13) : job horaire de fin d'essai,
e-mails J+1 / J-2 / J0, récapitulatif (`GET trial/recap`), écran de fin vu, événements `trial_*`,
tableau de conversion réservé à l'admin (`GET admin/trial-conversion`).

Le démarrage de l'essai et l'anti-abus (domaines jetables, empreinte, e-mail déjà utilisé) vivent dans
`api-auth` (vérification de l'e-mail). Stripe vit dans `api-billing`.

- `nx test api-trial`, `nx typecheck api-trial`, `nx lint api-trial`
