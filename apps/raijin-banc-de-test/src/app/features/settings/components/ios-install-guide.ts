import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Icon } from '../../../shared/ui/icon';

/** iPhone/iPad in Safari (not installed): Web Push only works once Raijin is on the home screen. */
@Component({
  selector: 'app-ios-install-guide',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3 border-info/40', 'data-testid': 'ios-install-guide' },
  template: `
    <p class="font-semibold">Pour recevoir les notifications sur iPhone :</p>
    <ol class="list-decimal space-y-2 pl-5 text-sm text-muted">
      <li>
        Dans Safari, touche <span class="font-semibold text-fg">Partager</span>
        <app-icon name="share" class="size-4 align-text-bottom text-info" />
        (icône carré avec flèche)
      </li>
      <li>« <span class="font-semibold text-fg">Sur l’écran d’accueil</span> »</li>
      <li>Ouvre Banc test depuis l’icône, puis active les notifications ici.</li>
    </ol>
  `,
})
export class IosInstallGuide {}
