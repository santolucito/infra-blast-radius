import * as assert from 'assert';
import { parseCloudFormation } from '../src/parsers/cloudformation';

const TEMPLATE = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  EnvName:
    Type: String
Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
  Subnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.1.0/24
  Instance:
    Type: AWS::EC2::Instance
    DependsOn: Subnet
    Properties:
      SubnetId: !Ref Subnet
      UserData: !Sub "echo \${VPC.CidrBlock} \${EnvName} \${!Literal}"
  SG:
    Type: AWS::EC2::SecurityGroup
    Properties:
      VpcId: !GetAtt VPC.VpcId
`;

function edge(g: ReturnType<typeof parseCloudFormation>, s: string, t: string) {
  return g.edges.find((e) => e.source === s && e.target === t);
}

describe('CloudFormation parser', () => {
  const g = parseCloudFormation(TEMPLATE);

  it('detects all four resources as nodes', () => {
    assert.deepStrictEqual(g.nodes.map((n) => n.id).sort(), ['Instance', 'SG', 'Subnet', 'VPC']);
  });

  it('maps !Ref to a hard edge', () => {
    assert.strictEqual(edge(g, 'Subnet', 'VPC')?.kind, 'hard');
  });

  it('maps !GetAtt to a hard edge', () => {
    assert.strictEqual(edge(g, 'SG', 'VPC')?.kind, 'hard');
  });

  it('extracts refs from !Sub interpolations', () => {
    assert.ok(edge(g, 'Instance', 'VPC'), 'Instance should depend on VPC via Fn::Sub');
  });

  it('ignores parameter refs and escaped ${!Literal} in !Sub', () => {
    assert.ok(!g.nodes.find((n) => n.id === 'EnvName'), 'EnvName parameter must not be a node');
    assert.ok(!edge(g, 'Instance', 'EnvName'), 'no edge to a parameter');
    assert.ok(!edge(g, 'Instance', 'Literal'), 'escaped ${!Literal} must be skipped');
  });

  it('lets a hard ref dominate a DependsOn soft edge for the same pair', () => {
    // Instance Ref Subnet (hard) AND DependsOn Subnet (soft) -> hard wins.
    assert.strictEqual(edge(g, 'Instance', 'Subnet')?.kind, 'hard');
  });

  it('produces exactly the expected edge set', () => {
    const got = g.edges.map((e) => `${e.source}->${e.target}`).sort();
    assert.deepStrictEqual(got, [
      'Instance->Subnet',
      'Instance->VPC',
      'SG->VPC',
      'Subnet->VPC',
    ]);
  });

  it('categorizes types for presentation', () => {
    assert.strictEqual(g.nodes.find((n) => n.id === 'Instance')?.type, 'compute');
    assert.strictEqual(g.nodes.find((n) => n.id === 'VPC')?.type, 'network');
  });
});
