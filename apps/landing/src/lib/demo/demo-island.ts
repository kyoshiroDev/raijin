import { track } from '../analytics/track';

const VERDICTS = ['safe', 'warn', 'danger'] as const;
type DemoVerdict = (typeof VERDICTS)[number];

function isVerdict(value: string | undefined): value is DemoVerdict {
  return (VERDICTS as readonly string[]).includes(value ?? '');
}

/**
 * Démonstration (docs/ARCHITECTURE.md §15.4) : avec JS, le résultat calculé au build est masqué (`data-demo="idle"`,
 * place réservée) jusqu'au clic sur « Lancer la démonstration », puis révélé (`done`) et
 * `analyse_demo_resultat { verdict }` part. Aucun décalage de mise en page.
 */
export function bindDemo(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>('[data-demo-run]');
  const result = root.querySelector<HTMLElement>('[data-demo-result]');
  const overlay = root.querySelector<HTMLElement>('[data-demo-overlay]');
  const verdict = root.dataset['demoVerdict'];
  if (!button || !result || !overlay || !isVerdict(verdict)) return;

  root.dataset['demo'] = 'idle';
  overlay.hidden = false;

  button.addEventListener('click', () => {
    root.dataset['demo'] = 'done';
    overlay.hidden = true;
    result.focus({ preventScroll: true });
    track('analyse_demo_resultat', { verdict });
  });
}
