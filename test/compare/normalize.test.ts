import * as assert from 'assert';
import { normalizeCloudsplaining, CloudsplainingSummary } from '../../src/compare/normalize';

const broad: CloudsplainingSummary = {
  policyId: 'tpl.yaml#Broad',
  allowedActions: ['s3:GetObject', 's3:DeleteObject', 's3:PutBucketAcl'],
  serviceWildcards: ['s3'],
  risks: {
    permissions_management: ['s3:PutBucketAcl'],
    write: ['s3:DeleteObject'],
    data_exfiltration: ['s3:GetObject'],
  },
};

describe('normalizeCloudsplaining', () => {
  const findings = normalizeCloudsplaining([broad]);

  it('emits a breadth finding per allowed action', () => {
    const breadth = findings.filter((f) => f.category === 'breadth');
    assert.deepStrictEqual(breadth.map((f) => f.detail).sort(), [
      's3:DeleteObject',
      's3:GetObject',
      's3:PutBucketAcl',
    ]);
  });

  it('emits service_wildcard findings', () => {
    assert.deepStrictEqual(
      findings.filter((f) => f.category === 'service_wildcard').map((f) => f.detail),
      ['s3']
    );
  });

  it('emits risk-category findings tied to the subject', () => {
    const pm = findings.find((f) => f.category === 'permissions_management');
    assert.strictEqual(pm?.detail, 's3:PutBucketAcl');
    assert.strictEqual(pm?.subject, 'tpl.yaml#Broad');
    assert.strictEqual(pm?.source, 'cloudsplaining');
    assert.strictEqual(pm?.channel, 'iam');
  });

  it('skips summaries with an error', () => {
    assert.strictEqual(
      normalizeCloudsplaining([{ ...broad, error: 'boom' }]).length,
      0
    );
  });
});
