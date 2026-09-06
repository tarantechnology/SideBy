// esbuild pipeline: one MAIN-world bundle per service, plus the overlay and
// service worker, as IIFEs for MV3 + manifest/icons copy.
// `--watch` rebuilds on change and serves /version on :8788 so the dev
// service worker can reload the extension automatically.
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const DEV_PORT = 8788;

const SERVER_URL = process.env.SIDEBY_SERVER_URL ?? 'ws://localhost:8787/ws';
/** The room server also serves pages (join links, lobby, mock player). */
const SERVER_HTTP = SERVER_URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');

let buildId = String(Date.now());

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  loader: { '.css': 'text' },
  jsx: 'automatic',
  define: {
    __DEV__: JSON.stringify(dev),
    __SERVER_URL__: JSON.stringify(SERVER_URL),
    __SERVER_HTTP__: JSON.stringify(SERVER_HTTP),
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
  outdir: dist,
};

const entries = [
  { in: 'src/adapters/netflix/main.ts', out: 'netflix-main' },
  { in: 'src/adapters/disneyplus/main.ts', out: 'disneyplus-main' },
  { in: 'src/adapters/hulu/main.ts', out: 'hulu-main' },
  { in: 'src/adapters/mock/main.ts', out: 'mock-main' },
  { in: 'src/content.tsx', out: 'content' },
  { in: 'src/background.ts', out: 'background' },
];

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  // The manifest names the dev server; point its matches at the configured one.
  const manifest = (await readFile(join(here, 'manifest.json'), 'utf8')).replaceAll('http://localhost:8787/', `${SERVER_HTTP}/`);
  await writeFile(join(dist, 'manifest.json'), manifest);
  await cp(join(here, 'icons'), join(dist, 'icons'), { recursive: true });
  await writeFile(join(dist, 'build-id.txt'), buildId);
}

const stampPlugin = {
  name: 'sideby-stamp',
  setup(build) {
    build.onStart(() => { buildId = String(Date.now()); });
    // Resolve __BUILD_ID__ at bundle time to the current build id.
    build.onResolve({ filter: /^virtual:build-id$/ }, () => ({ path: 'build-id', namespace: 'sideby' }));
    build.onLoad({ filter: /.*/, namespace: 'sideby' }, () => ({ contents: `export const buildId = ${JSON.stringify(buildId)};`, loader: 'js' }));
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      await copyStatic();
      if (watch) console.log(`[sideby] built ${buildId}`);
    });
  },
};

await rm(dist, { recursive: true, force: true });

const ctx = await esbuild.context({
  ...common,
  entryPoints: entries.map((e) => ({ in: join(here, e.in), out: e.out })),
  plugins: [stampPlugin],
});

if (watch) {
  await ctx.watch();
  createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/version') { res.end(buildId); return; }
    res.statusCode = 404; res.end();
  }).listen(DEV_PORT, '127.0.0.1', () => console.log(`[sideby] dev version server on http://127.0.0.1:${DEV_PORT}/version`));
} else {
  await ctx.rebuild();
  await ctx.dispose();
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  console.log(`[sideby] built ${manifest.name} ${manifest.version} → ${dist}`);
}
