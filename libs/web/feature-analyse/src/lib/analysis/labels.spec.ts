import * as contracts from '@raijin/shared-contracts';
import * as labels from './labels';

describe('copies locales des contrats', () => {
  it('restent identiques aux contrats', () => {
    expect(labels.VERDICT_LABELS).toEqual(contracts.VERDICT_LABELS);
    expect(labels.CHECK_STATUS_LABELS).toEqual(contracts.CHECK_STATUS_LABELS);
    expect(labels.ANALYSIS_CHECK_IDS).toEqual(contracts.ANALYSIS_CHECK_IDS);
    expect(labels.ANALYSIS_CHECK_LABELS).toEqual(contracts.ANALYSIS_CHECK_LABELS);
    expect(labels.EXTERNAL_LINK_HOSTS).toEqual(contracts.EXTERNAL_LINK_HOSTS);
    expect(labels.ANALYSIS_DISCLAIMER).toBe(contracts.ANALYSIS_DISCLAIMER);
    expect(labels.SAFE_VERDICT_REMINDER).toBe(contracts.SAFE_VERDICT_REMINDER);
    expect(labels.LOCAL_ERROR_MESSAGES.MINT_INVALID).toBe(contracts.ANALYSIS_ERROR_MESSAGES.MINT_INVALID);
    expect(labels.LOCAL_ERROR_MESSAGES.ANALYSIS_NOT_FOUND).toBe(contracts.ANALYSIS_ERROR_MESSAGES.ANALYSIS_NOT_FOUND);
  });
});
