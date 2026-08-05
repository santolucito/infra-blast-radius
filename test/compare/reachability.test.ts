// Feedback edge ① — reachability → IAM weight. Checkov's public_exposure verdict
// on a resource sharpens the IAM findings whose actions target that same resource
// (docs/feedback-loops.md). These tests pin the resource-identity join and the
// amplification logic as pure functions.

import * as assert from 'assert';
import { ExtractedPolicy } from '../../src/compare/policy-extract';
import {
  applyReachabilityFeedbackPure,
  arnToToken,
  bucketNamesFromTf,
  publicResourceTokens,
  targetTokensForFinding,
} from '../../src/compare/reachability';
import { Finding } from '../../src/compare/types';

describe('reachability — resource-identity resolver', () => {
  it('maps aws_s3_bucket logical names to their bucket attribute', () => {
    const tf = `
resource "aws_s3_bucket" "lake" {
  bucket = "pipeline-lake"
}
resource "aws_s3_bucket" "noname" {
  tags = { env = "dev" }
}
`;
    const m = bucketNamesFromTf(tf);
    assert.strictEqual(m.get('lake'), 'pipeline-lake');
    // no `bucket = ...` -> fall back to the logical name
    assert.strictEqual(m.get('noname'), 'noname');
  });

  it('normalizes S3 ARNs (bucket + object forms) to a token, and passes through *', () => {
    assert.strictEqual(arnToToken('arn:aws:s3:::pipeline-lake'), 's3:pipeline-lake');
    assert.strictEqual(arnToToken('arn:aws:s3:::pipeline-lake/*'), 's3:pipeline-lake');
    assert.strictEqual(arnToToken('arn:aws:s3:::pipeline-lake/data/2026/*'), 's3:pipeline-lake');
    assert.strictEqual(arnToToken('*'), '*');
    // services not resolved in the prototype -> null (no amplification)
    assert.strictEqual(arnToToken('arn:aws:dynamodb:us-east-1:111122223333:table/t'), null);
  });

  it('extracts public tokens only from public_exposure network findings', () => {
    const buckets = new Map([['lake', 'pipeline-lake']]);
    const findings: Finding[] = [
      { source: 'checkov', channel: 'network', subject: '/infra/buckets.tf:aws_s3_bucket.lake', category: 'public_exposure', detail: 'CKV2_AWS_6' },
      // encryption on the same bucket must NOT mark it public
      { source: 'checkov', channel: 'network', subject: '/infra/buckets.tf:aws_s3_bucket.lake', category: 'encryption', detail: 'CKV_AWS_145' },
      // public_exposure on a non-S3 resource is unresolved in the prototype
      { source: 'checkov', channel: 'network', subject: '/infra/db.tf:aws_db_instance.main', category: 'public_exposure', detail: 'CKV_AWS_17' },
    ];
    const tokens = publicResourceTokens(findings, buckets);
    assert.deepStrictEqual([...tokens], ['s3:pipeline-lake']);
  });
});

describe('reachability — IAM finding to target resources', () => {
  const policy: ExtractedPolicy = {
    policyId: 'iam/policy.json',
    sourceFile: 'iam/policy.json',
    document: {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::pipeline-lake/*' },
        { Effect: 'Allow', Action: 'dynamodb:*', Resource: 'arn:aws:dynamodb:us-east-1:1:table/t' },
      ],
    },
  };
  const byId = new Map([[policy.policyId, policy]]);

  it('resolves the resource an action is granted on (exact + wildcard action match)', () => {
    const f: Finding = { source: 'cloudsplaining', channel: 'iam', subject: 'iam/policy.json', category: 'breadth', detail: 's3:PutObject' };
    assert.deepStrictEqual([...targetTokensForFinding(f, byId)], ['s3:pipeline-lake']);
  });

  it('matches a service wildcard grant (s3:*) via the finding detail service', () => {
    const wildPolicy: ExtractedPolicy = {
      policyId: 'p', sourceFile: 'p', document: { Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::pipeline-lake/*' }] },
    };
    const f: Finding = { source: 'cloudsplaining', channel: 'iam', subject: 'p', category: 'service_wildcard', detail: 's3' };
    assert.deepStrictEqual([...targetTokensForFinding(f, new Map([['p', wildPolicy]]))], ['s3:pipeline-lake']);
  });

  it('returns nothing for a non-IAM finding or an unknown policy', () => {
    const net: Finding = { source: 'checkov', channel: 'network', subject: 'x', category: 'public_exposure', detail: 'c' };
    assert.strictEqual(targetTokensForFinding(net, byId).size, 0);
    const orphan: Finding = { source: 'cloudsplaining', channel: 'iam', subject: 'missing', category: 'breadth', detail: 's3:GetObject' };
    assert.strictEqual(targetTokensForFinding(orphan, byId).size, 0);
  });
});

describe('reachability — amplification', () => {
  const policy: ExtractedPolicy = {
    policyId: 'iam/policy.json',
    sourceFile: 'iam/policy.json',
    document: { Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::pipeline-lake/*' }] },
  };
  const byId = new Map([[policy.policyId, policy]]);
  const iam = (detail: string): Finding => ({ source: 'cloudsplaining', channel: 'iam', subject: 'iam/policy.json', category: 'breadth', detail });

  it('sets exposureFactor on IAM findings that reach a public resource', () => {
    const out = applyReachabilityFeedbackPure([iam('s3:PutObject')], byId, new Set(['s3:pipeline-lake']), 3);
    assert.strictEqual(out[0].exposureFactor, 3);
  });

  it('leaves findings whose resource is not public untouched', () => {
    const out = applyReachabilityFeedbackPure([iam('s3:PutObject')], byId, new Set(['s3:some-other-bucket']), 3);
    assert.strictEqual(out[0].exposureFactor, undefined);
  });

  it('amplifies an unconstrained (Resource: "*") grant against any public resource', () => {
    const starPolicy: ExtractedPolicy = { policyId: 's', sourceFile: 's', document: { Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }] } };
    const f: Finding = { source: 'cloudsplaining', channel: 'iam', subject: 's', category: 'breadth', detail: 's3:PutObject' };
    const out = applyReachabilityFeedbackPure([f], new Map([['s', starPolicy]]), new Set(['s3:pipeline-lake']), 3);
    assert.strictEqual(out[0].exposureFactor, 3);
  });

  it('is a no-op when nothing is public (analyzers stay parallel)', () => {
    const input = [iam('s3:PutObject')];
    const out = applyReachabilityFeedbackPure(input, byId, new Set(), 3);
    assert.strictEqual(out[0].exposureFactor, undefined);
    assert.strictEqual(out, input); // returns the same array reference
  });
});
