import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCH_E2E_DATABASE_URL, E2E_DIR, OWNER_EMAIL, OWNER_PASSWORD, OWNER_STATE_FILE, totpAtStep, totpStepNow, type OwnerState } from './support/bench';
import { ensureNoForeignOwner, insertFixtures, withDb } from './support/db';

const WORKSPACE = join(__dirname, '..', '..', '..');
const CLI = join(WORKSPACE, 'dist', 'apps', 'raijin-banc-de-test-api', 'cli.js');

/**
 * Crée le propriétaire de test **par la CLI réelle** (`cli.js create-owner`, comme l'utilisateur dans le conteneur) :
 * mot de passe saisi deux fois, clé TOTP lue dans la sortie, code calculé et confirmé, codes de secours relevés.
 * Rien de secret n'est journalisé : la sortie de la CLI n'est affichée qu'en cas d'échec, clé et codes masqués.
 */
function createOwnerWithCli(): Promise<OwnerState> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'create-owner'], {
      cwd: WORKSPACE,
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'development',
        BENCH_DATABASE_URL: BENCH_E2E_DATABASE_URL,
        BENCH_OWNER_EMAIL: OWNER_EMAIL,
        REDIS_URL: 'none',
        BENCH_JOBS_ENABLED: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let secretBase32: string | null = null;
    let enrolledStep = 0;
    child.stdin.write(`${OWNER_PASSWORD}\n${OWNER_PASSWORD}\n`);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const key = /Clé : ([A-Z2-7]+)/.exec(out);
      if (key?.[1] && secretBase32 === null) {
        const secret = key[1];
        secretBase32 = secret;
        enrolledStep = totpStepNow();
        child.stdin.write(`${totpAtStep(secret, enrolledStep)}\n`);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const recoveryCodes = [...out.matchAll(/^ {2}([A-Z2-7]{5}-[A-Z2-7]{5})$/gm)].map((match) => match[1] ?? '');
      if (code !== 0 || secretBase32 === null || recoveryCodes.length !== 10) {
        const masked = (text: string) => text.replace(/[A-Z2-7]{16,}/g, '<clé>').replace(/[A-Z2-7]{5}-[A-Z2-7]{5}/g, '<code>');
        reject(new Error(`create-owner a échoué (code ${code}, ${recoveryCodes.length} codes de secours)\n${masked(out)}\n${masked(err)}`));
        return;
      }
      child.stdin.end();
      resolve({ secretBase32, enrolledStep, recoveryCodes });
    });
  });
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(E2E_DIR, { recursive: true });
  await withDb(async (db) => {
    await ensureNoForeignOwner(db);
    await insertFixtures(db);
  });
  const owner = await createOwnerWithCli();
  writeFileSync(OWNER_STATE_FILE, JSON.stringify(owner), { mode: 0o600 });
}
