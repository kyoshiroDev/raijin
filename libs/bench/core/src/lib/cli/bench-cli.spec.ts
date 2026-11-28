import { base32Decode, totpAt, verifyPassword } from '@raijin/server-security';
import { MemoryBenchAuthStore } from '../../testing/memory-auth-store';
import { OWNER_EMAIL, TestClock, testConfig } from '../../testing/test-app';
import { runBenchCli, type BenchCliIo } from './bench-cli';

const PASSWORD = 'phrase de passe toute neuve';

/** Terminal simulé : réponses aux questions, `code` calculé depuis la clé affichée. */
function fakeIo(answers: (string | ((output: string[]) => string))[]): BenchCliIo & { output: string[]; errors: string[]; secretPrompts: number } {
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    output,
    errors,
    secretPrompts: 0,
    out: (line: string) => output.push(line),
    err: (line: string) => errors.push(line),
    prompt: async (_question: string, options?: { secret?: boolean }) => {
      if (options?.secret) io.secretPrompts += 1;
      const next = answers.shift();
      return typeof next === 'function' ? next(output) : (next ?? '');
    },
  };
  return io;
}

function codeFrom(clock: TestClock) {
  return (output: string[]) => {
    const key = output.find((line) => line.startsWith('Clé : '))?.slice('Clé : '.length) ?? '';
    return totpAt(base32Decode(key), clock.now());
  };
}

describe('CLI du propriétaire', () => {
  const config = testConfig();

  it('create-owner : mot de passe (saisie masquée), TOTP confirmé, 10 codes de secours affichés une fois', async () => {
    const store = new MemoryBenchAuthStore();
    const clock = new TestClock();
    const io = fakeIo([PASSWORD, PASSWORD, codeFrom(clock)]);
    expect(await runBenchCli(['create-owner'], { store, config, io, now: clock.now, showQr: false })).toBe(0);
    expect(io.secretPrompts).toBe(2);
    expect(store.owner?.email).toBe(OWNER_EMAIL);
    expect(await verifyPassword(store.owner?.passwordHash ?? '', PASSWORD)).toBe(true);
    expect(store.totp?.enabledAt).not.toBeNull();
    expect(store.recovery.size).toBe(10);
    const codes = io.output.filter((line) => /^ {2}[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(line));
    expect(codes).toHaveLength(10);
    expect(store.totp?.secretEncrypted).not.toContain(io.output.find((line) => line.startsWith('Clé : '))?.slice(6) ?? 'x');

    const again = fakeIo([]);
    expect(await runBenchCli(['create-owner'], { store, config, io: again, now: clock.now })).toBe(1);
    expect(again.errors[0]).toContain('existe déjà');
  });

  it('create-owner : mot de passe trop court, confirmation différente ou égal à l’e-mail → 3 essais puis abandon', async () => {
    const store = new MemoryBenchAuthStore();
    const io = fakeIo(['court', PASSWORD, 'autre chose encore', OWNER_EMAIL]);
    expect(await runBenchCli(['create-owner'], { store, config, io, showQr: false })).toBe(1);
    expect(io.errors).toEqual(['Au moins 12 caractères.', 'Les deux saisies diffèrent.', 'Le mot de passe ne peut pas être l’adresse e-mail.']);
    expect(store.owner).toBeNull();
  });

  it('create-owner : TOTP faux 3 fois → second facteur non activé (connexion impossible)', async () => {
    const store = new MemoryBenchAuthStore();
    const clock = new TestClock();
    const io = fakeIo([PASSWORD, PASSWORD, '000000', 'abc', '999999']);
    expect(await runBenchCli(['create-owner'], { store, config, io, now: clock.now, showQr: true })).toBe(1);
    expect(io.errors).toEqual(['Code incorrect.', 'Code incorrect.', 'Code incorrect.', 'TOTP non activé : connexion impossible tant que reset-2fa n’a pas abouti.']);
    expect(io.output.some((line) => line.includes('█') || line.includes('▀'))).toBe(true);
    expect(store.totp?.enabledAt).toBeNull();
  });

  it('set-password et reset-2fa : sessions fermées, anciens codes remplacés', async () => {
    const store = new MemoryBenchAuthStore();
    const clock = new TestClock();
    await runBenchCli(['create-owner'], { store, config, io: fakeIo([PASSWORD, PASSWORD, codeFrom(clock)]), now: clock.now, showQr: false });
    const ownerId = store.owner?.id ?? '';
    await store.createSession({ ownerId, tokenHash: 'h'.repeat(43), userAgent: null, ipHash: null, createdAt: clock.now(), expiresAt: new Date(clock.now().getTime() + 3600_000) });
    const before = [...store.recovery.keys()];

    const newPassword = 'encore une autre phrase';
    const setIo = fakeIo([newPassword, newPassword]);
    expect(await runBenchCli(['set-password'], { store, config, io: setIo, now: clock.now })).toBe(0);
    expect(setIo.output.at(-1)).toBe('Mot de passe changé ; 1 session(s) fermée(s).');
    expect(await verifyPassword(store.owner?.passwordHash ?? '', newPassword)).toBe(true);
    expect([...store.sessions.values()][0]?.revokedReason).toBe('password_change');

    clock.advance(60_000);
    expect(await runBenchCli(['reset-2fa'], { store, config, io: fakeIo([codeFrom(clock)]), now: clock.now, showQr: false })).toBe(0);
    expect([...store.recovery.keys()].some((hash) => before.includes(hash))).toBe(false);
    expect(store.totp?.enabledAt).not.toBeNull();
  });

  it('usage : commande inconnue (64), argument en trop refusé (aucun secret en ligne de commande), set-password sans propriétaire', async () => {
    const store = new MemoryBenchAuthStore();
    expect(await runBenchCli(['register'], { store, config, io: fakeIo([]) })).toBe(64);
    expect(await runBenchCli(['set-password', 'motdepasse'], { store, config, io: fakeIo([]) })).toBe(64);
    expect(await runBenchCli(['help'], { store, config, io: fakeIo([]) })).toBe(0);
    const io = fakeIo([]);
    expect(await runBenchCli(['reset-totp'], { store, config, io })).toBe(1);
    expect(io.errors[0]).toContain('create-owner');
  });
});
