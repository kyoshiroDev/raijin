import { Test } from '@nestjs/testing';
import { benchLivenessSchema } from '@raijin/bench-contracts';
import { HealthController } from './health.controller';

describe('HealthController (banc)', () => {
  it('répond un état conforme au contrat', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    const body = moduleRef.get(HealthController).health();
    expect(benchLivenessSchema.parse(body)).toEqual({ status: 'ok' });
  });
});
