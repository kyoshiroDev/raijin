import { TestBed } from '@angular/core/testing';
import { RjVerdictBadge, type RjVerdict } from './verdict-badge';

describe('RjVerdictBadge', () => {
  const cases: [RjVerdict, string, string][] = [
    ['safe', 'Sain', 'text-safe'],
    ['warn', 'Prudence', 'text-warn'],
    ['danger', 'Danger', 'text-danger'],
  ];

  it.each(cases)('%s : icône + mot « %s »', async (verdict, word, color) => {
    const fixture = TestBed.createComponent(RjVerdictBadge);
    fixture.componentRef.setInput('verdict', verdict);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent?.trim()).toBe(word);
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.getAttribute('aria-label')).toBe(`Verdict : ${word}`);
    expect(host.className).toContain(color);
    expect(host.className).toContain('rounded-sm');
  });
});
