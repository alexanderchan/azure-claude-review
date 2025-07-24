#!/usr/bin/env node

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const entryPoint = join(__dirname, 'src/claude-review.ts');
const outdir = 'bin';

console.log('🔨 Building TypeScript CLI...');
console.log(`📂 Entry: ${entryPoint}`);
console.log(`📦 Output: ${outdir}/`);

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  target: 'node22',
  packages: 'external',
  outdir,
  outExtension: { '.js': '.js' },
  format: 'esm',
  minify: false,
  sourcemap: false,
  metafile: true,
});

// Show what was built
if (result.metafile) {
  const outputs = Object.keys(result.metafile.outputs);
  console.log('📋 Built files:');
  outputs.forEach(output => {
    const stats = fs.statSync(output);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`   ${output} (${sizeKB} KB)`);
  });
}

console.log('✅ Build completed successfully');