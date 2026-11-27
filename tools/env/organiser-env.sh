#!/usr/bin/env bash
# Range tes fichiers de variables (docs/ENV.md « Où mettre quoi »). À lancer PAR TOI, depuis la racine du dépôt :
#
#   bash tools/env/organiser-env.sh            # sauvegarde .env, le réorganise, crée/complète .env.dev et .env.prod
#   bash tools/env/organiser-env.sh --check    # n'écrit rien : liste les variables obligatoires encore vides
#   bash tools/env/organiser-env.sh --example  # régénère aussi .env.example (valeurs factices)
#
# Aucune valeur n'est affichée (seulement des noms de variables). Fichiers écrits en 600, jamais commités.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
command -v node >/dev/null || { echo "ERREUR : Node.js est introuvable (version 22 ou plus : https://nodejs.org)." >&2; exit 1; }
umask 077
exec node tools/env/env-tool.mjs "$@"
