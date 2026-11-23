import { ADMIN_NOTICE_BODY_MAX, adminNoticeTemplate, cleanNoticeText } from './admin-notice-templates';

const ctx = { logoUrl: 'https://app.raijinshield.com/icons/icon-192.png', appUrl: 'https://app.raijinshield.com' };

describe('adminNoticeTemplate (CLI notify-admins)', () => {
  it('titre et corps échappés (jamais interprétés), lignes en paragraphes, texte brut', () => {
    const mail = adminNoticeTemplate(ctx, 'Sauvegarde <b>échouée</b>', 'ligne 1 <script>alert(1)</script>\nligne 2 & fin');
    expect(mail.subject).toBe('Raijin admin : Sauvegarde <b>échouée</b>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('ligne 2 &amp; fin');
    expect(mail.text).toContain('ligne 1 <script>alert(1)</script>');
  });

  it('borné à 2 000 caractères, caractères de contrôle retirés, titre vide remplacé', () => {
    expect(cleanNoticeText('a\u0000b\u202Ec\r\nd', 100)).toBe('abc\nd');
    expect(cleanNoticeText('x'.repeat(5_000), ADMIN_NOTICE_BODY_MAX)).toHaveLength(ADMIN_NOTICE_BODY_MAX);
    expect(adminNoticeTemplate(ctx, '   ', 'corps').subject).toBe('Raijin admin : Avis d’exploitation');
  });
});
