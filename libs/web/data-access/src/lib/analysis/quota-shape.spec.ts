import { QUOTA_KINDS, planSchema, quotaInfoSchema, quotaSubjectSchema } from '@raijin/shared-contracts';
import { SHAPE_PLANS, SHAPE_QUOTA_KINDS, SHAPE_QUOTA_SUBJECTS, readQuotaInfo } from './quota-shape';

const valid = {
  kind: 'analysis',
  subject: 'anonymous',
  plan: null,
  limit: 3,
  used: 1,
  remaining: 2,
  resetsAt: '2026-11-25T00:00:00.000Z',
};

describe('readQuotaInfo (sans Zod)', () => {
  it('reprend les listes des contrats', () => {
    expect(SHAPE_QUOTA_KINDS).toEqual([...QUOTA_KINDS]);
    expect(SHAPE_QUOTA_SUBJECTS).toEqual([...quotaSubjectSchema.options]);
    expect(SHAPE_PLANS).toEqual([...planSchema.options]);
  });

  it('accepte et rejette comme quotaInfoSchema', () => {
    const samples: unknown[] = [
      valid,
      { ...valid, plan: 'PRO', subject: 'user', limit: null, remaining: null },
      { ...valid, extra: 'retiré' },
      { ...valid, resetsAt: '2026-11-25T00:00Z' },
      { ...valid, resetsAt: '2026-11-25T00:00:00+01:00' },
      { ...valid, resetsAt: '2026-11-25' },
      { ...valid, resetsAt: '2026-13-40T00:00:00Z' },
      { ...valid, resetsAt: '2026-11-25T25:00:00Z' },
      { ...valid, kind: 'other' },
      { ...valid, subject: 'robot' },
      { ...valid, plan: 'GOLD' },
      { ...valid, limit: 0 },
      { ...valid, limit: 1.5 },
      { ...valid, used: -1 },
      { ...valid, remaining: -2 },
      { ...valid, used: '1' },
      { ...valid, resetsAt: undefined },
      null,
      [],
      'quota',
    ];
    for (const sample of samples) {
      const expected = quotaInfoSchema.safeParse(sample);
      if (expected.success) {
        expect(readQuotaInfo(sample)).toEqual(expected.data);
      } else {
        expect(() => readQuotaInfo(sample), JSON.stringify(sample)).toThrow();
      }
    }
  });
});
