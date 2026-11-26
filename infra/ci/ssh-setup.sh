#!/usr/bin/env bash
# GitHub Actions uniquement (workflow « Déploiement ») : écrit la clé SSH de déploiement de l'environnement visé et
# l'empreinte épinglée du VPS dans $RUNNER_TEMP/ssh (droits 600), sans jamais les afficher. Variables : KEY (secret
# DEPLOY_SSH_KEY_DEV ou DEPLOY_SSH_KEY_PROD), KNOWN_HOSTS (secret DEPLOY_KNOWN_HOSTS). docs/DEPLOY.md C5.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "ssh-setup.sh : réservé à GitHub Actions." >&2; exit 1; }
[[ -n "${KEY:-}" ]] || { echo "::error::secret DEPLOY_SSH_KEY_${DEPLOY_ENV^^} absent (Settings → Secrets and variables → Actions, docs/DEPLOY.md C5)."; exit 1; }
[[ -n "${KNOWN_HOSTS:-}" ]] || { echo "::error::secret DEPLOY_KNOWN_HOSTS absent (docs/DEPLOY.md C5)."; exit 1; }
dir="$RUNNER_TEMP/ssh"
umask 077
mkdir -p "$dir"
printf '%s\n' "$KEY" | tr -d '\r' >"$dir/deploy_key"
printf '%s\n' "$KNOWN_HOSTS" | tr -d '\r' >"$dir/known_hosts"
chmod 600 "$dir/deploy_key" "$dir/known_hosts"
ssh-keygen -y -f "$dir/deploy_key" >/dev/null 2>&1 || { echo "::error::clé SSH de déploiement illisible (format OpenSSH, sans phrase de passe)."; exit 1; }
grep -qE '^[^#[:space:]]+[[:space:]]+(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)[[:space:]]' "$dir/known_hosts" \
  || { echo "::error::DEPLOY_KNOWN_HOSTS : ligne known_hosts attendue (ssh-keyscan -t ed25519 <IP>)."; exit 1; }
echo "clé de déploiement ${DEPLOY_ENV:-?} et empreinte du VPS en place."
