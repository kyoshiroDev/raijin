import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

/**
 * Environnement de l'API des tests e2e (sources simulées, jobs déclenchés par les tests, push simulé,
 * e-mails groupés après 1 s, préfixe BullMQ dédié). Jamais utilisé hors de ce banc local.
 */
export const E2E_API_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'development',
  ANALYSIS_FIXTURES: '1',
  TRUST_PROXY: '1',
  JOBS_TEST_TRIGGER: '1',
  PUSH_PROVIDER: 'fake',
  ALERT_EMAIL_BATCH_DELAY_S: '1',
  BULLMQ_PREFIX: 'raijin-e2e',
  ALERT_COOLDOWN_MINUTES: '0',
  ANALYTICS_PROVIDER: 'fake',
};

const READY = 'API Raijin';
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Lance `dist/apps/api/main.js` (construit par `api:build`) et attend qu'il écoute. Le processus est
 * possédé par Jest (global-setup → global-teardown) : son arrêt ne dépend plus d'une tâche continue Nx
 * (« continuous but exited with code 0 », l'arrêt propre de Nest sortant avec le code 0).
 */
export async function startApi(workspaceRoot: string, port: number, host: string): Promise<ChildProcess> {
  if (await portInUse(port, host)) {
    throw new Error(`Le port ${port} est déjà utilisé : arrête l'API qui l'occupe avant de lancer les tests e2e.`);
  }
  const logDir = join(workspaceRoot, 'dist', 'api-e2e');
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, 'api.log'));
  const child = spawn(process.execPath, [join(workspaceRoot, 'dist', 'apps', 'api', 'main.js')], {
    cwd: workspaceRoot,
    env: { ...process.env, ...E2E_API_ENV, API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('L’API ne démarre pas (voir dist/api-e2e/api.log).')), START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes(READY)) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`L’API s’est arrêtée au démarrage (code ${code ?? 'signal'}, voir dist/api-e2e/api.log).`));
    });
  });
  return child;
}

/** Arrêt propre (SIGTERM, hooks Nest), puis SIGKILL au-delà de 10 s. */
export async function stopApi(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
