import { RISK_ENGINE_VERSION } from './shared-risk-engine';

describe('shared-risk-engine', () => {
  it('expose une version semver', () => {
    expect(RISK_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
