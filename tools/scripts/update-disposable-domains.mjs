// Met à jour la liste des domaines d'e-mail jetables de l'anti-abus de l'essai Pro
// (docs/ARCHITECTURE.md §13.6). Source : disposable-email-domains (licence CC0), fichier
// disposable_email_blocklist.conf. Lancé à la main (une fois par trimestre et en phase 9), diff relu
// puis commité ; l'API ne télécharge jamais rien au démarrage.
//
//   node tools/scripts/update-disposable-domains.mjs            (télécharge la branche main)
//   node tools/scripts/update-disposable-domains.mjs fichier.conf  (fichier déjà téléchargé)
//
// Ajouts et exceptions maison : libs/api/auth/src/lib/trial/disposable-domains.local.ts (non touché ici).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'disposable-email-domains/disposable-email-domains';
const FILE = 'disposable_email_blocklist.conf';
const output = join(import.meta.dirname, '..', '..', 'libs', 'api', 'auth', 'src', 'lib', 'trial', 'disposable-domains.generated.ts');
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'raijin-update-script' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${url}`);
  return response.text();
}

async function main() {
  const localFile = process.argv[2];
  let raw;
  let commit = 'inconnu (fichier local)';
  if (localFile) {
    raw = readFileSync(localFile, 'utf8');
  } else {
    const meta = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/commits/main`));
    commit = String(meta.sha);
    raw = await fetchText(`https://raw.githubusercontent.com/${REPO}/${commit}/${FILE}`);
  }
  const domains = [...new Set(raw.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line && !line.startsWith('#')))]
    .filter((domain) => DOMAIN.test(domain))
    .sort();
  if (domains.length < 1_000) throw new Error(`Liste suspecte (${domains.length} domaines) : rien n'est écrit.`);
  const date = new Date().toISOString().slice(0, 10);
  const content = `// Fichier généré par tools/scripts/update-disposable-domains.mjs : ne pas modifier à la main.
// Source : https://github.com/${REPO} (${FILE}), licence CC0 1.0.
// Commit source : ${commit} · généré le ${date} · ${domains.length} domaines.
// Ajouts et exceptions maison : disposable-domains.local.ts.

export const DISPOSABLE_DOMAINS_SOURCE = { repository: '${REPO}', commit: '${commit}', generatedAt: '${date}' } as const;

export const DISPOSABLE_DOMAINS_GENERATED: readonly string[] = [
${domains.map((domain) => `  '${domain}',`).join('\n')}
];
`;
  writeFileSync(output, content);
  console.log(`${domains.length} domaines écrits dans ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
