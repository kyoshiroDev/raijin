import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { TokenLink } from '../token-display';
import { Icon } from '../../../shared/ui/icon';

/** External links: hrefs come only from tokenLinks() (validated addresses / safeExternalUrl). */
@Component({
  selector: 'app-token-link-list',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (links().length) {
      <ul class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        @for (link of links(); track link.label) {
          <li>
            <a
              class="btn-ghost w-full px-2 text-info"
              [href]="link.href"
              target="_blank"
              rel="noopener noreferrer"
              [attr.aria-label]="link.label + ' (nouvel onglet)'"
            >
              {{ link.label }}
              <app-icon name="external" class="size-3.5" />
            </a>
          </li>
        }
      </ul>
    } @else {
      <p class="text-sm text-muted">Aucun lien vérifié.</p>
    }
  `,
})
export class TokenLinkList {
  readonly links = input.required<readonly TokenLink[]>();
}
