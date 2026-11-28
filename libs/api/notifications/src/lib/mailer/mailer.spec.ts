import type { Transporter } from 'nodemailer';
import { testConfig } from '@raijin/api-core';
import { createMailer } from '../api-notifications.module';
import { AuthMailService } from '../auth-mail.service';
import { Mailer, maskEmail, type MailMessage } from './mailer';
import { ResendMailer } from './resend.mailer';
import { SmtpMailer } from './smtp.mailer';

const message: MailMessage = { to: 'jean@exemple.fr', subject: 'Objet', html: '<p>Bonjour</p>', text: 'Bonjour' };

describe('mailers', () => {
  it('maskEmail', () => {
    expect(maskEmail('jean@exemple.fr')).toBe('j***@exemple.fr');
  });

  it('SmtpMailer transmet le message avec l’expéditeur configuré', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const mailer = new SmtpMailer(
      { host: 'localhost', port: 1026, from: 'Raijin <noreply@raijinshield.com>', user: null, password: null },
      { sendMail } as unknown as Transporter,
    );
    await mailer.send(message);
    expect(sendMail).toHaveBeenCalledWith({ from: 'Raijin <noreply@raijinshield.com>', ...message });
  });

  it('SmtpMailer crée un transport réel sans authentification par défaut', () => {
    expect(
      new SmtpMailer({ host: 'localhost', port: 1026, from: 'x@y.fr', user: 'u', password: 'p' }),
    ).toBeInstanceOf(Mailer);
  });

  it('ResendMailer appelle l’API HTTP avec la clé en Bearer', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await new ResendMailer('re_cle', 'Raijin <noreply@raijinshield.com>', fetchMock as unknown as typeof fetch).send(message);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer re_cle');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['jean@exemple.fr'], subject: 'Objet' });
  });

  it('ResendMailer échoue sans divulguer la clé', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 422 });
    const mailer = new ResendMailer('re_cle_secrete', 'x@y.fr', fetchMock as unknown as typeof fetch);
    await expect(mailer.send(message)).rejects.toMatchObject({ code: 'RESEND_REJECTED', responseCode: 422 });
    await expect(mailer.send(message)).rejects.not.toThrow('re_cle_secrete');
  });

  it('createMailer : SMTP par défaut, Resend seulement avec une vraie clé', () => {
    expect(createMailer(testConfig())).toBeInstanceOf(SmtpMailer);
    expect(createMailer(testConfig({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_vraie' }))).toBeInstanceOf(ResendMailer);
    expect(createMailer(testConfig({ MAIL_PROVIDER: 'resend' }))).toBeInstanceOf(SmtpMailer);
  });
});

describe('AuthMailService', () => {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { send: async (m: MailMessage) => void sent.push(m) };
  const service = new AuthMailService(mailer, testConfig({ APP_URL: 'https://app.raijinshield.com' }));

  beforeEach(() => (sent.length = 0));

  it('construit les liens avec APP_URL et le jeton en paramètre', async () => {
    await service.sendEmailVerification('a@b.fr', 'TOKEN_123');
    await service.sendPasswordReset('a@b.fr', 'TOKEN_456');
    await service.sendMagicLink('a@b.fr', 'TOKEN_789');
    expect(sent.map((m) => m.to)).toEqual(['a@b.fr', 'a@b.fr', 'a@b.fr']);
    expect(sent[0]?.text).toContain('https://app.raijinshield.com/compte/verifier-email?token=TOKEN_123');
    expect(sent[1]?.text).toContain('https://app.raijinshield.com/compte/reinitialiser-mot-de-passe?token=TOKEN_456');
    expect(sent[2]?.text).toContain('https://app.raijinshield.com/compte/lien-magique?token=TOKEN_789');
  });

  it('e-mails sans jeton', async () => {
    await service.sendWelcome('a@b.fr', null);
    await service.sendAccountExists('a@b.fr');
    await service.sendPasswordChanged('a@b.fr');
    expect(sent.map((m) => m.subject)).toEqual([
      'Bienvenue sur Raijin',
      'Tu as déjà un compte Raijin',
      'Ton mot de passe a changé',
    ]);
    expect(service.link('/compte/connexion')).toBe('https://app.raijinshield.com/compte/connexion');
  });
});
