import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPolicies } from '../../src/compare/policy-extract';

const CFN = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  AppRole:
    Type: AWS::IAM::Role
    Properties:
      Policies:
        - PolicyName: read-bucket
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: s3:GetObject
                Resource: arn:aws:s3:::my-bucket/*
  BroadPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Action: 's3:*'
            Resource: '*'
`;

const BARE = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*' }],
});

describe('extractPolicies', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
    fs.writeFileSync(path.join(dir, 'template.yaml'), CFN);
    fs.writeFileSync(path.join(dir, 'standalone.json'), BARE);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('extracts inline role policies and managed policies from CFN', () => {
    const ids = extractPolicies(dir).map((p) => p.policyId).sort();
    assert.ok(ids.includes('template.yaml#AppRole/read-bucket'));
    assert.ok(ids.includes('template.yaml#BroadPolicy'));
  });

  it('extracts a bare IAM policy json file', () => {
    const bare = extractPolicies(dir).find((p) => p.policyId === 'standalone.json');
    assert.ok(bare);
    assert.deepStrictEqual((bare!.document as any).Statement[0].Action, 'kms:Decrypt');
  });

  it('uses paths relative to rootDir so ids are stable across worktrees', () => {
    const ids = extractPolicies(dir).map((p) => p.policyId);
    assert.ok(ids.every((id) => !path.isAbsolute(id.split('#')[0])));
  });
});
