import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountExistsTemplate,
  formatTtl,
  magicLinkTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
} from './auth-templates';
import { EMAIL_THEME, escapeHtml, LEGAL_NOTICE } from './layout';

const ctx = { logoUrl: 'https://app.raijinshield.com/icons/icon-192.png', appUrl: 'https://app.raijinshield.com' };
const link = 'https://app.raijinshield.com/compte/verifier-email?token=abc_DEF-123';

describe('thème des e-mails', () => {
  it('reprend exactement les couleurs « light » de libs/brand/tokens.json', () => {
    const tokens = JSON.parse(
      readFileSync(join(__dirname, '../../../../../brand/tokens.json'), 'utf8'),
    ) as { color: { tokens: { name: string; value: { light: string } }[] } };
    for (const [name, value] of Object.entries(EMAIL_THEME)) {
      const token = tokens.color.tokens.find((t) => t.name === name);
      expect({ name, value }).toEqual({ name, value: token?.value.light });
    }
  });
});

describe('templates d’auth', () => {
  it('formatTtl', () => {
    expect(formatTtl(86_400_000)).toBe('24 heures');
    expect(formatTtl(172_800_000)).toBe('2 jours');
    expect(formatTtl(3_600_000)).toBe('1 heure');
    expect(formatTtl(7_200_000)).toBe('2 heures');
    expect(formatTtl(1_800_000)).toBe('30 minutes');
    expect(formatTtl(60_000)).toBe('1 minute');
  });

  it('escapeHtml neutralise les caractères dangereux', () => {
    expect(escapeHtml('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });

  it.each([
    ['vérification', verifyEmailTemplate(ctx, link, 86_400_000), 'Confirme ton adresse e-mail', '24 heures'],
    ['réinitialisation', passwordResetTemplate(ctx, link, 1_800_000), 'Réinitialise ton mot de passe', '30 minutes'],
    ['lien magique', magicLinkTemplate(ctx, link, 900_000), 'Ton lien de connexion Raijin', '15 minutes'],
  ])('%s : HTML thème clair + texte, lien, durée, logo, mention légale', (_label, mail, subject, ttl) => {
    expect(mail.subject).toBe(subject);
    expect(mail.html).toContain('data-theme="light"');
    expect(mail.html).toContain('lang="fr"');
    expect(mail.html).toContain(ctx.logoUrl);
    expect(mail.html).toContain(link);
    expect(mail.html).toContain(ttl);
    expect(mail.html).toContain(escapeHtml(LEGAL_NOTICE));
    expect(mail.html).toContain('max-width:600px');
    expect(mail.text).toContain(link);
    expect(mail.text).toContain(ttl);
    expect(mail.text).toContain(LEGAL_NOTICE);
    expect(mail.text).not.toContain('<');
  });

  it('bienvenue : sans essai, puis avec date de fin d’essai', () => {
    const free = welcomeTemplate(ctx, null);
    expect(free.subject).toBe('Bienvenue sur Raijin');
    expect(free.html).toContain(`${ctx.appUrl}/analyse`);
    expect(free.text).toContain('Le risque zéro n’existe pas');
    expect(free.html).not.toContain('rai-bravo');
    expect(free.text).not.toContain('essai');
    const trial = welcomeTemplate({ ...ctx, assetsBaseUrl: 'https://app.raijinshield.com/email' }, { endsAt: new Date('2026-12-01T12:00:00Z'), days: 7 });
    expect(trial.text).toContain('essai Pro de 7 jours');
    expect(trial.text).toContain('1 décembre');
    expect(trial.text).toContain('sans rien payer');
    expect(trial.html).toContain('src="https://app.raijinshield.com/email/rai-bravo@2x.png"');
    expect(trial.html).toContain('alt="Rai, la mascotte de Raijin, te souhaite la bienvenue"');
  });

  it('compte existant et mot de passe changé', () => {
    const exists = accountExistsTemplate(ctx, `${ctx.appUrl}/compte/connexion`, `${ctx.appUrl}/compte/mot-de-passe-oublie`);
    expect(exists.subject).toBe('Tu as déjà un compte Raijin');
    expect(exists.text).toContain('/compte/connexion');
    expect(exists.html).toContain('/compte/mot-de-passe-oublie');
    const changed = passwordChangedTemplate(ctx, `${ctx.appUrl}/compte/mot-de-passe-oublie`);
    expect(changed.subject).toBe('Ton mot de passe a changé');
    expect(changed.text).toContain('déconnectées');
  });

  it('aucun texte ne promet de gain', () => {
    const all = [
      verifyEmailTemplate(ctx, link, 1),
      welcomeTemplate(ctx, null),
      magicLinkTemplate(ctx, link, 1),
    ]
      .map((m) => m.text.toLowerCase())
      .join(' ');
    for (const forbidden of ['x10', 'moon', 'gem', 'achète', 'opportunité']) {
      expect(all).not.toContain(forbidden);
    }
  });
});
