// Tests for the granted-vs-used analyzer: static SDK-usage extraction and the
// granted − used diff. The extraction tests are pure; the diff test shells out
// to Cloudsplaining and self-skips when it isn't installed.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractUsedActions, extractUsage } from '../../src/compare/usage/extractor';
import { loadManifestLinks } from '../../src/compare/usage/link';
import { computeGrantUsed } from '../../src/compare/usage/diff';
import { resolvePython } from '../../src/compare/adapters/cloudsplaining';

// __dirname is out/test/compare at runtime; the shim lives in the source tree.
const SHIM = path.resolve(__dirname, '../../../src/compare/adapters/cloudsplaining_shim.py');

function mkdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('usage/extractor', () => {
  it('detects aws-sdk v2 bound-variable calls', () => {
    const dir = mkdir('usage-v2-');
    fs.writeFileSync(
      path.join(dir, 'h.js'),
      `const AWS = require('aws-sdk');
       const s3 = new AWS.S3();
       async function f() { await s3.getObject({Bucket:'b',Key:'k'}).promise(); }`,
    );
    const actions = extractUsedActions(dir);
    assert.ok(actions.has('s3:GetObject'), [...actions].join(','));
  });

  it('detects aws-sdk v3 command classes (incl. via .send)', () => {
    const dir = mkdir('usage-v3-');
    fs.writeFileSync(
      path.join(dir, 'h.ts'),
      `import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
       const c = new SecretsManagerClient({});
       export async function f() { await c.send(new GetSecretValueCommand({ SecretId: 's' })); }`,
    );
    const actions = extractUsedActions(dir);
    assert.ok(actions.has('secretsmanager:GetSecretValue'), [...actions].join(','));
  });

  it('detects inline v2 construction and the DynamoDB DocumentClient', () => {
    const dir = mkdir('usage-mix-');
    fs.writeFileSync(
      path.join(dir, 'h.js'),
      `const AWS = require('aws-sdk');
       new AWS.SNS().publish({});
       const ddb = new AWS.DynamoDB.DocumentClient();
       ddb.get({});`,
    );
    const actions = extractUsedActions(dir);
    assert.ok(actions.has('sns:Publish'), [...actions].join(','));
    assert.ok(actions.has('dynamodb:GetItem'), [...actions].join(','));
  });

  it('returns a sorted, de-duplicated action list and ignores comments', () => {
    const dir = mkdir('usage-sort-');
    fs.writeFileSync(
      path.join(dir, 'h.js'),
      `const AWS = require('aws-sdk');
       const s3 = new AWS.S3();
       s3.putObject({}); s3.getObject({}); s3.getObject({});
       // s3.deleteObject({});  <- commented out, must NOT count
       /* s3.deleteBucket({}); */`,
    );
    const { actions } = extractUsage(dir);
    assert.deepStrictEqual(actions, ['s3:GetObject', 's3:PutObject']);
  });

  it('does not false-positive on ordinary, non-distinctive method names', () => {
    const dir = mkdir('usage-fp-');
    fs.writeFileSync(
      path.join(dir, 'h.js'),
      `const db = makeOrm();
       db.query('SELECT 1'); emitter.publish('evt'); fn.invoke();`,
    );
    assert.strictEqual(extractUsedActions(dir).size, 0);
  });
});

describe('usage/link', () => {
  it('loads code→policy mappings from blast-usage.json', () => {
    const dir = mkdir('usage-link-');
    fs.writeFileSync(path.join(dir, 'blast-usage.json'), JSON.stringify({ src: 'fix-B.json' }));
    const links = loadManifestLinks(dir);
    assert.strictEqual(links.length, 1);
    assert.deepStrictEqual(
      { codeDir: links[0].codeDir, policyFile: links[0].policyFile, via: links[0].via },
      { codeDir: 'src', policyFile: 'fix-B.json', via: 'manifest' },
    );
  });
});

describe('usage/diff (granted − used)', function () {
  this.timeout(60_000);

  it('flags unused broad grants (s3:*) but not an exactly-scoped policy', async function (this: Mocha.Context) {
    const py = await resolvePython();
    if (!py || !fs.existsSync(SHIM)) {
      // eslint-disable-next-line no-console
      console.warn('  (skipped: cloudsplaining not installed)');
      this.skip();
      return;
    }

    const repo = mkdir('usage-diff-');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(
      path.join(repo, 'src', 'h.js'),
      `const AWS = require('aws-sdk');
       const s3 = new AWS.S3();
       exports.h = async () => s3.getObject({Bucket:'b',Key:'k'}).promise();`,
    );
    fs.writeFileSync(
      path.join(repo, 'broad.json'),
      JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }),
    );
    fs.writeFileSync(
      path.join(repo, 'scoped.json'),
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }],
      }),
    );

    const broad = await computeGrantUsed({ repoRoot: repo, codeDir: 'src', policyFile: 'broad.json', python: py, shimPath: SHIM });
    const scoped = await computeGrantUsed({ repoRoot: repo, codeDir: 'src', policyFile: 'scoped.json', python: py, shimPath: SHIM });

    // Code uses exactly s3:GetObject.
    assert.deepStrictEqual(broad.used, ['s3:GetObject']);

    // Broad grant expands to many actions, almost all unnecessary, incl. high-risk.
    assert.ok(broad.counts.granted > 50, `granted=${broad.counts.granted}`);
    assert.ok(broad.counts.unnecessary > 50, `unnecessary=${broad.counts.unnecessary}`);
    assert.ok(broad.counts.unnecessaryHighRisk > 0, 'expected high-risk unused grants');
    assert.ok(broad.unnecessary.includes('s3:DeleteObject'));
    assert.ok(!broad.unnecessary.includes('s3:GetObject'), 'used action must not be unnecessary');

    // Scoped grant: granted == used == {s3:GetObject}; nothing unnecessary.
    assert.deepStrictEqual(scoped.granted, ['s3:GetObject']);
    assert.strictEqual(scoped.counts.unnecessary, 0);
    assert.strictEqual(scoped.counts.unnecessaryHighRisk, 0);
  });
});
