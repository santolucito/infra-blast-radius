import * as assert from 'assert';
import * as path from 'path';
import { CheckovAdapter } from '../../src/compare/adapters/checkov';
import {
  normalizeCheckov,
  CheckovFailedCheck,
} from '../../src/compare/checkov-normalize';
import { AnalysisContext } from '../../src/compare/adapters/types';

// --- Pure normalizer tests (no checkov binary required) ---
describe('normalizeCheckov', () => {
  const failed: CheckovFailedCheck[] = [
    {
      check_id: 'CKV_AWS_24',
      check_name: 'Ensure no security groups allow ingress from 0.0.0.0:0 to port 22',
      resource: 'aws_security_group.open',
      file_path: '/main.tf',
    },
    {
      check_id: 'CKV_AWS_20',
      check_name: 'S3 Bucket has an ACL defined which allows public READ access',
      resource: 'aws_s3_bucket.public',
      file_path: '/main.tf',
    },
    {
      check_id: 'CKV_AWS_19',
      check_name: 'Ensure all data stored in the S3 bucket is securely encrypted at rest',
      resource: 'aws_s3_bucket.public',
      file_path: '/main.tf',
    },
    {
      check_id: 'CKV_AWS_99999',
      check_name: 'Some unmapped governance tagging requirement',
      resource: 'aws_s3_bucket.public',
      file_path: '/main.tf',
    },
  ];

  const findings = normalizeCheckov(failed);

  it('maps an open security group to network_exposure', () => {
    const f = findings.find((x) => x.detail === 'CKV_AWS_24');
    assert.strictEqual(f?.category, 'network_exposure');
    assert.strictEqual(f?.channel, 'network');
    assert.strictEqual(f?.source, 'checkov');
  });

  it('maps a public S3 ACL to public_exposure', () => {
    const f = findings.find((x) => x.detail === 'CKV_AWS_20');
    assert.strictEqual(f?.category, 'public_exposure');
  });

  it('maps unencrypted storage to encryption', () => {
    const f = findings.find((x) => x.detail === 'CKV_AWS_19');
    assert.strictEqual(f?.category, 'encryption');
  });

  it('falls back to misconfiguration for unmapped, non-exposure checks', () => {
    const f = findings.find((x) => x.detail === 'CKV_AWS_99999');
    assert.strictEqual(f?.category, 'misconfiguration');
  });

  it('builds a stable subject from file_path + resource', () => {
    const f = findings.find((x) => x.detail === 'CKV_AWS_24');
    assert.strictEqual(f?.subject, '/main.tf:aws_security_group.open');
  });
});

// --- End-to-end adapter test (requires the checkov binary; skips if absent) ---
describe('CheckovAdapter (integration)', function () {
  this.timeout(180_000);
  const adapter = new CheckovAdapter();
  const fixture = path.join(__dirname, '..', '..', '..', 'test', 'compare', 'fixtures', 'checkov-tf');

  let findings: Awaited<ReturnType<CheckovAdapter['analyzeRaw']>> = [];

  before(async function () {
    if (!(await adapter.available())) this.skip();
    const ctx: AnalysisContext = { rootDir: fixture, policies: [] };
    findings = await adapter.analyzeRaw(ctx);
  });

  it('flags the open security group (network_exposure)', () => {
    const net = findings.filter((f) => f.category === 'network_exposure');
    assert.ok(net.length > 0, `expected a network_exposure finding, got ${findings.length} findings`);
    assert.ok(
      net.some((f) => f.subject.includes('aws_security_group.open')),
      'expected the open SG to be flagged'
    );
  });

  it('flags the public S3 bucket (public_exposure)', () => {
    const pub = findings.filter((f) => f.category === 'public_exposure');
    assert.ok(
      pub.some((f) => f.subject.includes('aws_s3_bucket')),
      'expected a public-exposure finding on the bucket'
    );
  });
});
