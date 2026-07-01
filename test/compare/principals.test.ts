// Principal reach: counting how many principals carry a policy (from the CFN
// attachment graph) and mapping that onto findings as a reachFactor.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPolicies } from '../../src/compare/policy-extract';
import { applyPrincipalReach, buildReachMap } from '../../src/compare/principals';
import { Finding } from '../../src/compare/types';

function tmpTemplate(json: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(json));
  return dir;
}

describe('principal reach — attachment counting', () => {
  it('counts a managed policy’s Roles/Users/Groups (Ref + literal name)', () => {
    const dir = tmpTemplate({
      Resources: {
        Shared: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: {
            Roles: [{ Ref: 'RoleX' }, 'literal-role-name'],
            Users: [{ Ref: 'UserY' }],
            PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] },
          },
        },
      },
    });
    const policies = extractPolicies(dir);
    const shared = policies.find((p) => p.policyId.endsWith('#Shared'));
    assert.ok(shared, 'expected the managed policy to be extracted');
    assert.strictEqual(shared!.principalCount, 3);
  });

  it('counts roles that reference the policy via ManagedPolicyArns (reverse edge)', () => {
    const dir = tmpTemplate({
      Resources: {
        Shared: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: {
            PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] },
          },
        },
        RoleA: { Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: [{ Ref: 'Shared' }] } },
        RoleB: { Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: [{ Ref: 'Shared' }] } },
      },
    });
    const shared = extractPolicies(dir).find((p) => p.policyId.endsWith('#Shared'));
    assert.strictEqual(shared!.principalCount, 2);
  });

  it('treats an inline role policy as attached to exactly one principal', () => {
    const dir = tmpTemplate({
      Resources: {
        MyRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Policies: [{ PolicyName: 'inline', PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] } }],
          },
        },
      },
    });
    const inline = extractPolicies(dir).find((p) => p.policyId.includes('/inline'));
    assert.strictEqual(inline!.principalCount, 1);
  });
});

describe('principal reach — applying reachFactor to findings', () => {
  const policies = [
    { policyId: 'template.json#Shared', document: {}, sourceFile: 'template.json', principalCount: 6 },
    { policyId: 'template.json#Dedicated', document: {}, sourceFile: 'template.json', principalCount: 1 },
  ];

  it('builds a reach map only for shared (>1) policies', () => {
    const m = buildReachMap(policies);
    assert.strictEqual(m.get('template.json#Shared'), 6);
    assert.ok(!m.has('template.json#Dedicated'));
  });

  it('tags findings on the shared policy, leaves dedicated + others untouched', () => {
    const findings: Finding[] = [
      { source: 'cloudsplaining', channel: 'iam', subject: 'template.json#Shared', category: 'data_exfiltration', detail: 'secretsmanager:GetSecretValue' },
      { source: 'cloudsplaining', channel: 'iam', subject: 'template.json#Dedicated', category: 'data_exfiltration', detail: 'secretsmanager:GetSecretValue' },
      { source: 'checkov', channel: 'network', subject: 'net.tf:sg', category: 'network_exposure', detail: 'CKV_AWS_24' },
    ];
    const out = applyPrincipalReach(findings, policies as any);
    assert.strictEqual(out[0].reachFactor, 6);
    assert.strictEqual(out[1].reachFactor, undefined);
    assert.strictEqual(out[2].reachFactor, undefined);
  });
});
