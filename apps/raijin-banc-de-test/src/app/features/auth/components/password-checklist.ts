import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { PasswordRuleResult } from '../password-rules';

/** Live list of password rules, each marked as met or not. */
@Component({
  selector: 'app-password-checklist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="space-y-1 text-sm" aria-live="polite">
      @for (rule of rules(); track rule.id) {
        <li class="flex items-center gap-2" [class.text-bull]="rule.ok" [class.text-muted]="!rule.ok" [attr.data-rule]="rule.id">
          <span aria-hidden="true" class="w-4 text-center">{{ rule.ok ? '✓' : '○' }}</span>
          <span>{{ rule.label }}</span>
          <span class="sr-only">{{ rule.ok ? '(respecté)' : '(non respecté)' }}</span>
        </li>
      }
    </ul>
  `,
})
export class PasswordChecklist {
  readonly rules = input.required<readonly PasswordRuleResult[]>();
}
