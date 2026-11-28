import { ATTRIBUTION_KEY } from '@raijin/web-data-access';
import { API, query, queryAll, settle, setupFeature, submitForm, type } from '../testing/harness';

// Premier chargement des écrans lazy : lent quand la machine compile en parallèle.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => sessionStorage.clear());

function check(harness: Parameters<typeof query>[0]): void {
  const box = query<HTMLInputElement>(harness, 'input[type="checkbox"]');
  if (!box) throw new Error('Case CGU introuvable');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
}

describe('RegisterPage', () => {
  it('exige les CGU et la longueur du mot de passe (contrats)', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/inscription');
    expect(query(harness, 'input[name="new-password"]')?.getAttribute('autocomplete')).toBe('new-password');
    expect(query(harness, '#' + query(harness, 'input[name="new-password"]')?.getAttribute('aria-describedby'))?.textContent).toContain(
      'Au moins 12 caractères',
    );
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    type(harness, 'Mot de passe', 'court');
    submitForm(harness);
    await harness.fixture.whenStable();
    expect(query(harness, 'input[type="checkbox"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(harness.routeNativeElement?.textContent).toContain('Accepte les conditions pour continuer.');
    ctrl.expectNone(`${API}/auth/register`);
  });

  it('envoie l’attribution retenue puis affiche « Vérifie ta boîte » (réponse neutre)', async () => {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({ utmSource: 'x', landingPath: '/analyse' }));
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/inscription');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    type(harness, 'Mot de passe', 'une phrase bien longue');
    check(harness);
    submitForm(harness);
    await settle(); // lecture asynchrone de l'attribution
    const req = ctrl.expectOne(`${API}/auth/register`);
    expect(req.request.body).toEqual({
      email: 'kenji@exemple.fr',
      password: 'une phrase bien longue',
      acceptTerms: true,
      attribution: { utmSource: 'x', landingPath: '/analyse' },
    });
    req.flush({ message: 'ok' }, { status: 202, statusText: 'Accepted' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, 'h1')?.textContent).toContain('Vérifie ta boîte mail');
    // Changement d'état majeur : le focus va sur le nouveau titre (atteignable en programme seulement).
    expect(query(harness, 'h1')?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(query(harness, 'h1'));
    expect(harness.routeNativeElement?.textContent).toContain('kenji@exemple.fr');
    const resend = queryAll(harness, 'button').find((b) => b.textContent?.includes('Renvoyer'));
    expect(resend?.hasAttribute('disabled')).toBe(true);
  });

  it('mot de passe refusé par l’API : erreur sur le champ', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/inscription');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    type(harness, 'Mot de passe', 'kenji@exemple.fr');
    check(harness);
    submitForm(harness);
    await settle();
    ctrl
      .expectOne(`${API}/auth/register`)
      .flush({ code: 'AUTH_PASSWORD_REJECTED', message: 'x' }, { status: 400, statusText: 'Bad Request' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, 'input[name="new-password"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(harness.routeNativeElement?.textContent).toContain('Ce mot de passe est refusé');
  });
});
