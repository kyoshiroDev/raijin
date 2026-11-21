import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  model,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RjIcon } from '../icon/icon';

let nextId = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet sur mobile (monte du bas, poignée, safe area), modale centrée ou panneau latéral
 * dès 1024 px. Focus piégé dans le panneau, Échap et clic sur le fond ferment, le focus revient
 * sur l'élément déclencheur. Le défilement de la page est bloqué pendant l'ouverture.
 */
@Component({
  selector: 'rj-bottom-sheet',
  imports: [RjIcon],
  template: `
    @if (open()) {
      <div [class]="layerClasses()" animate.leave="rj-sheet-leave">
        <div class="rj-fade absolute inset-0 bg-base/80 backdrop-blur-sm" aria-hidden="true" (click)="close()"></div>
        <section
          #panel
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-labelledby]="titleId"
          [attr.aria-describedby]="description() ? descriptionId : null"
          [class]="panelClasses()"
          (keydown)="onKeydown($event)"
        >
          <div class="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line lg:hidden" aria-hidden="true"></div>
          <header class="flex items-start gap-3 py-2 pl-4 pr-2 md:pl-6 lg:pt-4">
            <div class="min-w-0 flex-1 pt-2">
              <h2 [id]="titleId" class="font-display text-h3 text-ink">{{ title() }}</h2>
              @if (description(); as description) {
                <p [id]="descriptionId" class="mt-1 text-body-sm text-ink-muted">{{ description }}</p>
              }
            </div>
            <button
              type="button"
              class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 ease-raijin hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-label="Fermer"
              (click)="close()"
            >
              <rj-icon name="close" [size]="20" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2 text-body text-ink md:px-6">
            <ng-content />
          </div>
          <footer class="flex flex-col-reverse gap-2 px-4 pt-4 pb-4 empty:hidden sm:flex-row sm:justify-end md:px-6 md:pb-6">
            <ng-content select="[rjSheetFooter]" />
          </footer>
        </section>
      </div>
    }
  `,
  styles: `
    @keyframes rj-up { from { transform: translateY(100%); } }
    @keyframes rj-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
    @keyframes rj-left { from { transform: translateX(100%); } }
    @keyframes rj-fade-in { from { opacity: 0; } }
    @keyframes rj-fade-out { to { opacity: 0; } }
    .rj-fade { animation: rj-fade-in 200ms var(--ease-raijin) both; }
    .rj-sheet { animation: rj-up 220ms var(--ease-raijin) both; }
    @media (min-width: 1024px) {
      .rj-sheet { animation-name: rj-pop; }
      .rj-sheet.rj-panel { animation-name: rj-left; }
    }
    .rj-sheet-leave { animation: rj-fade-out 150ms var(--ease-raijin) both; }
  `,
  host: { '(document:keydown.escape)': 'onEscape()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjBottomSheet {
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private returnFocus: HTMLElement | null = null;

  readonly open = model(false);
  readonly title = input.required<string>();
  readonly description = input('');
  /** Présentation dès 1024 px : modale centrée ou panneau latéral droit. */
  readonly desktop = input<'modal' | 'panel'>('modal');

  protected readonly titleId = `rj-sheet-${nextId++}`;
  protected readonly descriptionId = `${this.titleId}-desc`;

  protected readonly layerClasses = computed(() =>
    [
      'fixed inset-0 z-50 flex items-end justify-center pt-12',
      this.desktop() === 'panel' ? 'lg:items-stretch lg:justify-end lg:pt-0' : 'lg:items-center lg:p-8',
    ].join(' '),
  );

  protected readonly panelClasses = computed(() =>
    [
      'rj-sheet relative flex max-h-full w-full flex-col rounded-t-lg border border-b-0 border-line bg-surface pb-safe shadow-card focus:outline-none',
      this.desktop() === 'panel'
        ? 'rj-panel lg:h-full lg:max-w-md lg:rounded-none lg:rounded-l-lg lg:border-y-0 lg:border-r-0'
        : 'lg:max-w-lg lg:rounded-lg lg:border-b',
    ].join(' '),
  );

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => (isOpen ? this.onOpen() : this.onClose()));
    });
  }

  close(): void {
    this.open.set(false);
  }

  protected onEscape(): void {
    if (this.open()) {
      this.close();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const items = this.focusables();
    const panel = this.panel()?.nativeElement;
    if (!panel || items.length === 0) {
      event.preventDefault();
      panel?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  private focusables(): HTMLElement[] {
    const panel = this.panel()?.nativeElement;
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  private onOpen(): void {
    const active = this.document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.document.body.style.overflow = 'hidden';
    afterNextRender(
      () => {
        // Premier élément utile du contenu (après le bouton Fermer), sinon le panneau lui-même.
        const items = this.focusables();
        const target = items[1] ?? items[0] ?? this.panel()?.nativeElement;
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  private onClose(): void {
    this.document.body.style.overflow = '';
    const target = this.returnFocus;
    this.returnFocus = null;
    target?.focus();
  }
}
