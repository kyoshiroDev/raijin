import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Colonne des écrans d'auth : pleine largeur sur mobile, carte centrée de 448 px dès 640 px.
 * Contenu projeté, pied (`[rjAuthFooter]`) séparé par un filet.
 */
@Component({
  selector: 'rj-auth-layout',
  template: `
    <div
      class="mx-auto flex w-full max-w-md flex-col gap-6 sm:mt-4 sm:rounded-lg sm:border sm:border-line sm:bg-surface sm:p-8 lg:mt-10"
    >
      @if (title()) {
        <header class="flex flex-col gap-2">
          <h1 class="font-display text-h2 text-ink">{{ title() }}</h1>
          @if (subtitle(); as subtitle) {
            <p class="text-body text-ink-muted">{{ subtitle }}</p>
          }
        </header>
      }
      <ng-content />
      <footer
        class="flex flex-wrap items-center justify-center gap-x-1.5 border-t border-line pt-2 text-body-sm text-ink-muted empty:hidden"
      >
        <ng-content select="[rjAuthFooter]" />
      </footer>
    </div>
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAuthLayout {
  readonly title = input('');
  readonly subtitle = input('');
}
