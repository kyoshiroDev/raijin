import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from './content';

describe('contenu de la landing', () => {
  it('contient la mention « pas un conseil en investissement »', () => {
    expect(DISCLAIMER).toContain("Ce n'est pas un conseil en investissement.");
    expect(DISCLAIMER.startsWith('Raijin Shield')).toBe(true);
  });
});
