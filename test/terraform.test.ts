import * as assert from 'assert';
import { parseTerraformDot, parseTerraformShowJson } from '../src/parsers/terraform';

const DOT = `
digraph {
  compound = "true"
  newrank = "true"
  subgraph "root" {
    "[root] aws_instance.web (expand)" -> "[root] aws_subnet.public_a (expand)"
    "[root] aws_subnet.public_a (expand)" -> "[root] aws_vpc.main (expand)"
    "[root] module.net.aws_vpc.main (expand)" -> "[root] var.cidr (expand)"
    "[root] aws_instance.web (expand)" -> "[root] provider[\\"registry.terraform.io/hashicorp/aws\\"]"
  }
}
`;

describe('Terraform DOT parser', () => {
  const g = parseTerraformDot(DOT);

  it('keeps only resource/data addresses as nodes', () => {
    assert.deepStrictEqual(g.nodes.map((n) => n.id).sort(), [
      'aws_instance.web',
      'aws_subnet.public_a',
      'aws_vpc.main',
      'module.net.aws_vpc.main',
    ]);
  });

  it('drops provider and var edges, keeps resource->resource edges', () => {
    const got = g.edges.map((e) => `${e.source}->${e.target}`).sort();
    assert.deepStrictEqual(got, [
      'aws_instance.web->aws_subnet.public_a',
      'aws_subnet.public_a->aws_vpc.main',
    ]);
  });

  it('records the module for flattened module resources', () => {
    const n = g.nodes.find((x) => x.id === 'module.net.aws_vpc.main');
    assert.strictEqual(n?.module, 'module.net');
    assert.strictEqual(g.nodes.find((x) => x.id === 'aws_vpc.main')?.module, null);
  });
});

describe('Terraform plan severity mapping', () => {
  const json = JSON.stringify({
    resource_changes: [
      { address: 'aws_vpc.main', change: { actions: ['update'] } },
      { address: 'aws_subnet.public_a', change: { actions: ['delete', 'create'] } },
      { address: 'aws_instance.web', change: { actions: ['no-op'] } },
      { address: 'aws_s3_bucket.old', change: { actions: ['delete'] } },
    ],
  });
  const sev = parseTerraformShowJson(json);

  it('maps actions to severities', () => {
    assert.strictEqual(sev.get('aws_vpc.main'), 'update');
    assert.strictEqual(sev.get('aws_subnet.public_a'), 'replace');
    assert.strictEqual(sev.get('aws_instance.web'), 'noop');
    assert.strictEqual(sev.get('aws_s3_bucket.old'), 'destroy');
  });

  it('returns empty on malformed json', () => {
    assert.strictEqual(parseTerraformShowJson('not json').size, 0);
  });
});
