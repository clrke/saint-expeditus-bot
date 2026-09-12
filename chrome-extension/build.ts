import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const entryPoints = [
  path.join(__dirname, 'src/main.ts'),
  path.join(__dirname, 'src/background.ts'),
  path.join(__dirname, 'src/popup.ts'),
];

async function build() {
  await esbuild.build({
    entryPoints,
    bundle: true,
    outdir: path.join(__dirname, 'dist'),
    format: 'esm',
    target: 'chrome120',
    sourcemap: true,
    minify: false,
  });
  console.log('Build complete -> chrome-extension/dist/');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
