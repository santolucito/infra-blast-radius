#!/usr/bin/env node
// Local web front-end for blast-compare. This is JUST a UI: every number it shows
// comes from running the real CLI (dist/cli.js --json) on demand. No precomputed
// results. Zero external deps — Node's http + child_process only.
//
//   npm run web   ->   http://localhost:4173
//
// Endpoints:
//   GET  /api/examples          list examples + their authored infra graphs
//   POST /api/compare {example, weights?, noCheckov?}  -> live Comparison JSON

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 4173;

// Child processes need cloudsplaining (pipx venv, resolved by the adapter) and
// checkov (~/.local/bin) on PATH.
const ENV = { ...process.env, PATH: `${os.homedir()}/.local/bin:${process.env.PATH}` };

// ---------------------------------------------------------------------------
// Example registry: metadata + an authored infra graph per ref. The graph is the
// "visualizer" — nodes/edges positioned in a 0..1 space; the front-end scales it.
// The SCORES are always live from the CLI; only the topology is authored here.
// ---------------------------------------------------------------------------

const N = (id, label, type, pos, risk, note) => ({ id, label, type, pos, risk: risk || 'low', note });
const E = (from, to, label, risk, dashed) => ({ from, to, label: label || '', risk: risk || 'low', dashed: !!dashed });

const EXAMPLES = {
  tradeoff: {
    title: 'Cross-channel tradeoff',
    subtitle: 'tighter IAM vs. an open network — neither obviously wins',
    dir: 'tradeoff',
    noCheckov: false,
    weightsSlider: true, // network-exposure weight, drives the verdict
    fixes: { 'fix-A': 'tight IAM, opens the network', 'fix-B': 'broader IAM, network stays shut' },
    story:
      'A batch job starts over-broad (s3:*). fix-A scopes IAM to two actions but opens the ' +
      'security group to 0.0.0.0/0. fix-B keeps the network locked but needs broader (still ' +
      'scoped) IAM. Slide the threat model and watch the verdict move.',
    graph: {
      baseline: {
        nodes: [
          N('job', 'batch job', 'compute', [0.28, 0.5]),
          N('pol', 'IAM policy', 'policy', [0.52, 0.5], 'high', 's3:*'),
          N('s3', 'S3 (all)', 'data', [0.8, 0.5], 'high'),
          N('inet', 'internet', 'network', [0.28, 0.9]),
          N('sg', 'security group', 'network', [0.52, 0.9], 'low', 'private'),
        ],
        edges: [E('job', 'pol'), E('pol', 's3', 's3:*', 'high'), E('inet', 'sg', 'blocked', 'low', true)],
      },
      'fix-A': {
        nodes: [
          N('job', 'batch job', 'compute', [0.28, 0.5], 'high', 'public IP'),
          N('pol', 'IAM policy', 'policy', [0.52, 0.5], 'low', 'scoped'),
          N('s3', 'S3 bucket', 'data', [0.8, 0.5], 'low', 'job-data'),
          N('inet', 'internet', 'network', [0.28, 0.9], 'high'),
          N('sg', 'security group', 'network', [0.52, 0.9], 'high', '0.0.0.0/0'),
        ],
        edges: [
          E('job', 'pol'),
          E('pol', 's3', 'Get/PutObject', 'low'),
          E('inet', 'sg', 'OPEN', 'high'),
          E('sg', 'job', '', 'high'),
        ],
      },
      'fix-B': {
        nodes: [
          N('job', 'batch job', 'compute', [0.28, 0.5]),
          N('pol', 'IAM policy', 'policy', [0.52, 0.5], 'med', '5 scoped'),
          N('s3', 'S3 bucket', 'data', [0.82, 0.32], 'low'),
          N('secret', 'secret', 'data', [0.82, 0.5], 'med'),
          N('ddb', 'DynamoDB', 'data', [0.82, 0.68], 'med'),
          N('inet', 'internet', 'network', [0.28, 0.9]),
          N('sg', 'security group', 'network', [0.52, 0.9], 'low', 'private'),
        ],
        edges: [
          E('job', 'pol'),
          E('pol', 's3', 'Get/Put', 'low'),
          E('pol', 'secret', 'GetSecretValue', 'med'),
          E('pol', 'ddb', 'Get/PutItem', 'med'),
          E('inet', 'sg', 'blocked', 'low', true),
        ],
      },
    },
  },

  'shared-role': {
    title: 'Dedicated vs. shared role',
    subtitle: 'reuse the shared platform role, or give the job its own?',
    dir: 'shared-role',
    noCheckov: true,
    weightsSlider: false,
    fixes: { 'fix-A': 'dedicated least-privilege role', 'fix-B': 'attach to the shared platform role' },
    story:
      'A reporting job only reads one bucket. fix-A gives it a dedicated role with exactly ' +
      's3:GetObject. fix-B "reuses the shared PlatformAccess role" — a one-line change that ' +
      'silently inherits s3:*, dynamodb:*, kms:Decrypt and a secret, 82 actions the code never calls.',
    graph: {
      'fix-A': {
        nodes: [
          N('job', 'reporting job', 'compute', [0.25, 0.5]),
          N('role', 'dedicated role', 'policy', [0.5, 0.5], 'low', '1 action'),
          N('s3', 'export bucket', 'data', [0.78, 0.5], 'low'),
        ],
        edges: [E('job', 'role'), E('role', 's3', 's3:GetObject', 'low')],
      },
      'fix-B': {
        nodes: [
          N('job', 'reporting job', 'compute', [0.16, 0.5]),
          N('role', 'shared PlatformAccess', 'policy', [0.44, 0.5], 'high', 'broad'),
          N('sa', 'svc-a', 'principal', [0.16, 0.14]),
          N('sb', 'svc-b', 'principal', [0.16, 0.3]),
          N('sc', 'svc-c', 'principal', [0.16, 0.7]),
          N('sd', 'svc-d', 'principal', [0.16, 0.86]),
          N('s3', 'S3 (all)', 'data', [0.8, 0.24], 'high'),
          N('ddb', 'DynamoDB (all)', 'data', [0.82, 0.42], 'high'),
          N('secret', 'secrets', 'data', [0.82, 0.6], 'high'),
          N('kms', 'KMS decrypt', 'data', [0.8, 0.78], 'high'),
        ],
        edges: [
          E('job', 'role', '', 'high'),
          E('sa', 'role', '', 'med'), E('sb', 'role', '', 'med'),
          E('sc', 'role', '', 'med'), E('sd', 'role', '', 'med'),
          E('role', 's3', 's3:*', 'high'),
          E('role', 'ddb', 'dynamodb:*', 'high'),
          E('role', 'secret', 'GetSecretValue', 'high'),
          E('role', 'kms', 'Decrypt', 'high'),
        ],
      },
    },
  },

  'shared-reach': {
    title: 'Principal reach',
    subtitle: 'the same grant, on a dedicated role vs. one shared by 6 services',
    dir: 'shared-reach',
    noCheckov: true,
    weightsSlider: false,
    fixes: { 'fix-A': 'grant via a dedicated policy (1 role)', 'fix-B': 'add to the shared policy (6 roles)' },
    story:
      'A reporting service needs secretsmanager:GetSecretValue. The IAM statement is byte-identical ' +
      'in both fixes — the only difference is who carries it. On the shared policy the grant is ' +
      'reachable by all 6 services, so its blast radius is 6x.',
    graph: {
      'fix-A': {
        nodes: [
          N('rs', 'reporting-svc', 'principal', [0.25, 0.5]),
          N('pol', 'dedicated policy', 'policy', [0.52, 0.5], 'low', '1 role'),
          N('secret', 'secret', 'data', [0.8, 0.5], 'med'),
        ],
        edges: [E('rs', 'pol'), E('pol', 'secret', 'GetSecretValue', 'med')],
      },
      'fix-B': {
        nodes: [
          N('a', 'svc-a', 'principal', [0.14, 0.1]),
          N('b', 'svc-b', 'principal', [0.14, 0.26]),
          N('c', 'svc-c', 'principal', [0.14, 0.42]),
          N('d', 'svc-d', 'principal', [0.14, 0.58]),
          N('e', 'svc-e', 'principal', [0.14, 0.74]),
          N('f', 'svc-f', 'principal', [0.14, 0.9]),
          N('pol', 'shared PlatformAccess', 'policy', [0.5, 0.5], 'high', '6 roles'),
          N('secret', 'secret', 'data', [0.84, 0.5], 'high', '6x reach'),
        ],
        edges: [
          E('a', 'pol', '', 'high'), E('b', 'pol', '', 'high'), E('c', 'pol', '', 'high'),
          E('d', 'pol', '', 'high'), E('e', 'pol', '', 'high'), E('f', 'pol', '', 'high'),
          E('pol', 'secret', 'GetSecretValue x6', 'high'),
        ],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Build each example's git repo once, cache the path.
// ---------------------------------------------------------------------------
const repoCache = {};
function ensureRepo(ex) {
  if (repoCache[ex]) return repoCache[ex];
  const dest = path.join(os.tmpdir(), `blast-web-${ex}`);
  fs.rmSync(dest, { recursive: true, force: true });
  const script = path.join(ROOT, 'examples', ex, 'build-repo.sh');
  execFileSync('bash', [script, dest], { env: ENV });
  repoCache[ex] = dest;
  return dest;
}

function runCompare(ex, opts, cb) {
  const cfg = EXAMPLES[ex];
  if (!cfg) return cb(new Error(`unknown example ${ex}`));
  let repo;
  try {
    repo = ensureRepo(ex);
  } catch (e) {
    return cb(new Error(`build-repo failed: ${e.message}`));
  }
  const args = [CLI, '--repo', repo, '--base', 'main', '--ref:A', 'fix-A', '--ref:B', 'fix-B', '--json'];
  if (cfg.noCheckov) args.push('--no-checkov');
  let weightsFile;
  if (opts.weights) {
    weightsFile = path.join(os.tmpdir(), `blast-web-w-${ex}.json`);
    fs.writeFileSync(weightsFile, JSON.stringify(opts.weights));
    args.push('--weights', weightsFile);
  }
  execFile('node', args, { env: ENV, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && !stdout) return cb(new Error(stderr || err.message));
    try {
      cb(null, JSON.parse(stdout));
    } catch (e) {
      cb(new Error(`bad JSON from CLI: ${e.message}\n${stderr}`));
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(req, res) {
  let rel = req.url.split('?')[0];
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/examples') {
    const list = Object.entries(EXAMPLES).map(([id, e]) => ({
      id, title: e.title, subtitle: e.subtitle, story: e.story,
      fixes: e.fixes, weightsSlider: e.weightsSlider, graph: e.graph,
    }));
    return sendJson(res, 200, list);
  }

  if (url === '/api/compare' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let opts = {};
      try { opts = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
      const cfg = EXAMPLES[opts.example];
      let weights;
      if (cfg && cfg.weightsSlider && typeof opts.networkWeight === 'number') {
        const w = opts.networkWeight;
        weights = { category: { network_exposure: w, public_exposure: w, encryption: 2, misconfiguration: 1 } };
      }
      const t0 = Date.now();
      runCompare(opts.example, { weights }, (err, comparison) => {
        if (err) return sendJson(res, 500, { error: err.message });
        sendJson(res, 200, { comparison, tookMs: Date.now() - t0 });
      });
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  blast-compare web UI  ->  http://localhost:${PORT}\n`);
});
