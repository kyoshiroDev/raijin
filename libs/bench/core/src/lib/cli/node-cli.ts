import { BenchPrismaService } from '@raijin/bench-prisma';
import { createInterface } from 'node:readline';
import { PrismaBenchAuthStore } from '../auth/auth.store';
import { BenchConfigError, loadBenchConfig } from '../config/bench-config';
import { errorCodeOf } from '../security/redact';
import { runBenchCli, type BenchCliIo } from './bench-cli';

/**
 * Terminal réel : une seule interface readline (les lignes d'un stdin redirigé ne sont pas perdues), saisie
 * masquée pour les mots de passe quand stdin est un terminal.
 */
export function createNodeCliIo(): BenchCliIo & { close(): void } {
  const interactive = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let ended = false;
  let muted = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve('');
  });
  const writer = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WritableStream };
  const original = writer._writeToOutput.bind(rl);
  writer._writeToOutput = (text: string) => {
    if (!muted) original(text);
    else if (text.includes('\n') || text.includes('\r')) original('\n');
  };
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: (question, options) =>
      new Promise<string>((resolve) => {
        process.stdout.write(question);
        muted = options?.secret === true && interactive;
        const done = (line: string): void => {
          muted = false;
          resolve(line);
        };
        const buffered = lines.shift();
        if (buffered !== undefined) done(buffered);
        else if (ended) done('');
        else waiting.push(done);
      }),
    close: () => rl.close(),
  };
}

/** Point d'entrée de `cli.js` : configuration validée, base `raijin_bench`, code de sortie. */
export async function benchCliMain(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  let config;
  try {
    config = loadBenchConfig(env);
  } catch (error) {
    if (error instanceof BenchConfigError) {
      for (const problem of error.problems) process.stderr.write(`Configuration : ${problem}\n`);
      return 78;
    }
    throw error;
  }
  const io = createNodeCliIo();
  const prisma = new BenchPrismaService({ databaseUrl: config.databaseUrl });
  try {
    await prisma.$connect();
    return await runBenchCli(argv, { store: new PrismaBenchAuthStore(prisma), config, io });
  } catch (error) {
    io.err(`Échec (${errorCodeOf(error)}) : base raijin_bench injoignable ou migrations non appliquées ?`);
    return 1;
  } finally {
    io.close();
    await prisma.$disconnect().catch(() => undefined);
  }
}
