import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { type AdminRecoveryCodes } from '@raijin/shared-contracts';
import { RjButton, RjClipboard, RjToastService } from '@raijin/web-ui';
import { formatLongDay } from '../ui/format';

/** Nom du fichier téléchargé. */
export const RECOVERY_CODES_FILENAME = 'raijin-codes-de-secours.txt';

/** Contenu du fichier texte des codes de secours (une ligne par code, consignes en tête). */
export function recoveryCodesText(codes: AdminRecoveryCodes): string {
  return [
    'Raijin Shield — codes de secours de l’espace admin',
    `Générés le ${formatLongDay(codes.generatedAt)}.`,
    'Chaque code ne sert qu’une fois. Range ce fichier hors de ton téléphone (gestionnaire de mots de passe, papier).',
    '',
    ...codes.codes,
    '',
  ].join('\n');
}

/**
 * Codes de secours montrés **une seule fois** : grille de 2 colonnes en mono, copie de tous les codes et
 * téléchargement d'un fichier `.txt`. Rien n'est conservé par le navigateur.
 */
@Component({
  selector: 'rj-recovery-codes-list',
  imports: [RjButton],
  template: `
    <ol class="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-line bg-surface-raised p-3 xs:gap-x-4 xs:p-4" aria-label="Codes de secours">
      @for (code of codes().codes; track code; let i = $index) {
        <li class="flex items-baseline gap-2">
          <span class="tabular w-4 shrink-0 text-right xs:w-5 text-label text-ink-muted" aria-hidden="true">{{ i + 1 }}.</span>
          <span class="font-mono text-data font-semibold whitespace-nowrap text-ink select-all xs:text-body xs:tracking-wide">{{ code }}</span>
        </li>
      }
    </ol>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button type="button" rjButton="secondary" [icon]="copied() ? 'check' : 'copy'" (click)="copy()">
        {{ copied() ? 'Codes copiés' : 'Copier les codes' }}
      </button>
      <button type="button" rjButton="secondary" icon="download" (click)="download()">Télécharger (.txt)</button>
    </div>
  `,
  host: { class: 'flex flex-col gap-3' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjRecoveryCodesList {
  private readonly clipboard = inject(RjClipboard);
  private readonly toasts = inject(RjToastService);
  private readonly document = inject(DOCUMENT);

  readonly codes = input.required<AdminRecoveryCodes>();
  protected readonly copied = signal(false);
  private readonly text = computed(() => recoveryCodesText(this.codes()));

  protected async copy(): Promise<void> {
    const ok = await this.clipboard.copy(this.text());
    this.copied.set(ok);
    this.toasts.show(ok ? 'Codes copiés. Colle-les dans un endroit sûr.' : 'Copie impossible : télécharge le fichier à la place.', {
      tone: ok ? 'success' : 'error',
    });
  }

  protected download(): void {
    const view = this.document.defaultView;
    if (!view?.URL?.createObjectURL) return;
    const url = view.URL.createObjectURL(new Blob([this.text()], { type: 'text/plain;charset=utf-8' }));
    const link = this.document.createElement('a');
    link.href = url;
    link.download = RECOVERY_CODES_FILENAME;
    link.rel = 'noopener';
    this.document.body.appendChild(link);
    link.click();
    link.remove();
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
  }
}
