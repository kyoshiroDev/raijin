import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Badge permanent « BANC DE TEST » (PROMPT.md §4.8) : rappelle sur chaque écran que l'on est dans
 * le laboratoire privé, jamais dans Raijin. Couleur `warn` (même valeur que le token warn de
 * libs/brand/tokens.css, vérifié par bench-badge.spec.ts), toujours avec un libellé.
 */
@Component({
  selector: 'app-bench-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex shrink-0 items-center rounded-full border border-warn/60 bg-warn/10 px-2 py-0.5 text-label font-bold tracking-wider text-warn uppercase select-none',
    role: 'note',
    'aria-label': 'Banc de test : environnement privé, non destiné au public',
    'data-testid': 'bench-badge',
  },
  template: `BANC DE TEST`,
})
export class BenchBadge {}
