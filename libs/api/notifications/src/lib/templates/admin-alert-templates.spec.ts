import { adminAlertLine, adminAlertSubject, adminAlertTemplate } from './admin-alert-templates';

const ctx = { logoUrl: 'https://app.raijinshield.com/email/logo.png', appUrl: 'https://app.raijinshield.com' };

describe('E-mail d’alerte admin', () => {
  it('job en échec et quota : texte neutre, compteurs, lien vers la santé, échappement', () => {
    const mail = adminAlertTemplate(ctx, [
      { kind: 'job_failing', label: 'Purge <quotidienne>', level: 'critical', consecutiveFailures: 3, lastErrorCode: 'ECONNRESET' },
      { kind: 'quota_threshold', label: 'Helius (crédits, total)', level: 'warning', used: 850000, limit: 1000000, ratio: 0.85 },
    ]);
    expect(mail.subject).toBe('Raijin admin : 2 alertes (dont critique)');
    expect(mail.html).toContain('data-theme="light"');
    expect(mail.html).toContain('Purge &lt;quotidienne&gt;');
    expect(mail.html).not.toContain('<quotidienne>');
    expect(mail.html).toContain('https://app.raijinshield.com/admin/sante');
    expect(mail.text).toContain('85 % du quota du jour utilisé (850 000 sur 1 000 000)'.replace(/ (?=\d{3}\b)/g, ' '));
    expect(mail.text).toContain('pas un conseil en investissement');
  });

  it('objet et lignes d’une alerte seule', () => {
    expect(adminAlertSubject([{ kind: 'job_failing', label: 'x', level: 'critical' }])).toBe('Raijin admin : un job échoue');
    expect(adminAlertLine({ kind: 'job_failing', label: 'Purge', level: 'critical', consecutiveFailures: 1 })).toBe('Purge : 1 échec de suite.');
  });
});
