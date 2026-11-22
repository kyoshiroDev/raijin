import { Test } from '@nestjs/testing';
import { ApiAnalysisModule } from './api-analysis.module';

describe('ApiAnalysisModule', () => {
  it('se compile dans un module de test Nest', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiAnalysisModule] }).compile();
    expect(moduleRef.get(ApiAnalysisModule)).toBeInstanceOf(ApiAnalysisModule);
    await moduleRef.close();
  });
});
