'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Extension host bundle (Node, vscode external).
const extensionConfig = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

// Webview bundle (browser; Cytoscape + dagre bundled in).
const webviewConfig = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

// CLI bundle (Node) for the comparison frontend.
const cliConfig = {
  ...common,
  entryPoints: ['src/compare/cli.ts'],
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
};

// The Python shim is a runtime asset; copy it next to the CLI bundle.
function copyShim() {
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync(
    path.join('src', 'compare', 'adapters', 'cloudsplaining_shim.py'),
    path.join('dist', 'cloudsplaining_shim.py')
  );
}

async function main() {
  if (watch) {
    const ctxA = await esbuild.context(extensionConfig);
    const ctxB = await esbuild.context(webviewConfig);
    const ctxC = await esbuild.context(cliConfig);
    await Promise.all([ctxA.watch(), ctxB.watch(), ctxC.watch()]);
    copyShim();
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(cliConfig),
    ]);
    copyShim();
    console.log('[esbuild] build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
