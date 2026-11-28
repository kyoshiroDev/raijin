/**
 * Seed de développement minimal (jamais en production) : un compte vérifié `dev@raijin.local`.
 * Mot de passe : SEED_USER_PASSWORD si fourni, sinon généré et affiché une seule fois (compte local).
 * Lancement : pnpm nx run api-prisma:seed (base locale du docker-compose.dev.yml).
 */
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash, argon2id } from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client';

const FALLBACK_DEV_URL = 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Seed refusé en production.');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] || FALLBACK_DEV_URL }),
  });
  try {
    const email = 'dev@raijin.local';
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`Seed : ${email} existe déjà, rien à faire.`);
      return;
    }
    const provided = process.env['SEED_USER_PASSWORD'];
    const password = provided && provided.length >= 12 ? provided : randomBytes(12).toString('base64url');
    await prisma.user.create({
      data: {
        email,
        emailNormalized: email,
        passwordHash: await hash(password, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        utmSource: 'seed',
      },
    });
    console.log(`Seed : compte local ${email} créé.`);
    if (!provided) console.log(`Mot de passe local (affiché une seule fois) : ${password}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
