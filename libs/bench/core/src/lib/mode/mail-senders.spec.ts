import { loadBenchConfig } from '../config/bench-config';
import { legacyEnv, flatDetails } from '../config/legacy-env';
import { NullBenchMailSender } from './bench-notifier';
import { benchAlertRecipient, createBenchMailSender, maskAddress, ResendBenchMailSender, SmtpBenchMailSender, smtpOptions } from './mail-senders';

const BASE = { NODE_ENV: 'test', BENCH_OWNER_EMAIL: 'proprietaire@banc.invalid' };

describe('e-mails du banc (BENCH_MAIL_TRANSPORT)', () => {
  it('none par défaut : aucun expéditeur, aucun destinataire', () => {
    const config = loadBenchConfig(BASE);
    expect(config.mail).toEqual({ transport: 'none' });
    expect(createBenchMailSender(config.mail)).toBeInstanceOf(NullBenchMailSender);
    expect(benchAlertRecipient(config.mail)).toBeNull();
  });

  it('resend : clé obligatoire ; destinataire = BENCH_ALERT_EMAIL, sinon le propriétaire', () => {
    expect(() => loadBenchConfig({ ...BASE, BENCH_MAIL_TRANSPORT: 'resend', BENCH_MAIL_FROM: 'Banc <banc@exemple.invalid>' })).toThrow(/BENCH_RESEND_API_KEY/);
    const config = loadBenchConfig({ ...BASE, BENCH_MAIL_TRANSPORT: 'resend', BENCH_MAIL_FROM: 'Banc <banc@exemple.invalid>', BENCH_RESEND_API_KEY: 're_test_123' });
    expect(config.mail).toMatchObject({ transport: 'resend', to: 'proprietaire@banc.invalid' });
    expect(createBenchMailSender(config.mail)).toBeInstanceOf(ResendBenchMailSender);
  });

  it('smtp : URL smtp:// exigée ; valeur inconnue refusée', () => {
    expect(() => loadBenchConfig({ ...BASE, BENCH_MAIL_TRANSPORT: 'smtp', BENCH_MAIL_FROM: 'banc@exemple.invalid', BENCH_SMTP_URL: 'http://x' })).toThrow(/BENCH_SMTP_URL/);
    expect(() => loadBenchConfig({ ...BASE, BENCH_MAIL_TRANSPORT: 'sendgrid' })).toThrow(/BENCH_MAIL_TRANSPORT/);
    const config = loadBenchConfig({ ...BASE, BENCH_MAIL_TRANSPORT: 'smtp', BENCH_MAIL_FROM: 'banc@exemple.invalid', BENCH_SMTP_URL: 'smtp://localhost:1026', BENCH_ALERT_EMAIL: 'alertes@banc.invalid' });
    expect(config.mail).toMatchObject({ transport: 'smtp', to: 'alertes@banc.invalid' });
    expect(smtpOptions('smtps://u%40x:p@mail.exemple.invalid')).toMatchObject({ host: 'mail.exemple.invalid', port: 465, secure: true, auth: { user: 'u@x', pass: 'p' } });
  });

  it('Resend : requête attendue, la clé ne sort que dans l’en-tête ; échec → code seulement', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    const sender = new ResendBenchMailSender({ apiKey: 're_secret', from: 'Banc <banc@exemple.invalid>' }, fetchImpl as unknown as typeof fetch);
    expect(await sender.send({ to: 'a@b.invalid', subject: 'S', text: 'T' })).toEqual({ status: 'sent' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer re_secret');
    expect(String(init.body)).not.toContain('re_secret');
    const failing = new ResendBenchMailSender({ apiKey: 'k', from: 'f@x.invalid' }, (async () => new Response('', { status: 422 })) as unknown as typeof fetch);
    expect(await failing.send({ to: 'a@b.invalid', subject: 'S', text: 'T' })).toEqual({ status: 'failed', code: 'RESEND_HTTP_422' });
  });

  it('SMTP : transport injecté, erreur → code', async () => {
    const sendMail = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    const sender = new SmtpBenchMailSender({ url: 'smtp://localhost:1026', from: 'f@x.invalid' }, { sendMail } as never);
    expect(await sender.send({ to: 'a@b.invalid', subject: 'S', text: 'T' })).toEqual({ status: 'sent' });
    expect(await sender.send({ to: 'a@b.invalid', subject: 'S', text: 'T' })).toEqual({ status: 'failed', code: 'ECONNREFUSED' });
    expect(maskAddress('proprietaire@banc.invalid')).toBe('p***@banc.invalid');
  });
});

describe('variables des fonctions portées et détails de job', () => {
  it('legacyEnv : seuls les BENCH_* correspondants sont lus (jamais JUP_API_KEY de Raijin)', () => {
    const env = legacyEnv({ solanaEnv: { BENCH_JUP_API_KEY: ' k ', BENCH_MIN_LIQUIDITY: '', JUP_API_KEY: 'raijin' } });
    expect(env('JUP_API_KEY')).toBe('k');
    expect(env('MIN_LIQUIDITY')).toBeUndefined();
    expect(env('HELIUS_API_KEY')).toBeUndefined();
  });

  it('flatDetails : valeurs simples, un niveau imbriqué, 40 clés au plus', () => {
    expect(flatDetails({ a: 1, b: { c: true, d: { e: 1 } }, s: 'x'.repeat(200), arr: [1] })).toEqual({ a: 1, 'b.c': true, s: 'x'.repeat(120) });
    expect(Object.keys(flatDetails(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))))).toHaveLength(40);
  });
});
