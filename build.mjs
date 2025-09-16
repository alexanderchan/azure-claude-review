#!/usr/bin/env node

import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const logger = console;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const entryPoint = join(__dirname, "src/claude-review.ts");
const outdir = "bin";

logger.log("🔨 Building TypeScript CLI...");
logger.log(`📂 Entry: ${entryPoint}`);
logger.log(`📦 Output: ${outdir}/`);

const result = await build({
  entryPoints: [entryPoint],
  bundle: false,
  platform: "node",
  target: "node22",
  packages: "external",
  outdir,
  outExtension: { ".js": ".js" },
  format: "esm",
  minify: false,
  sourcemap: false,
  metafile: true,
});

// Show what was built
if (result.metafile) {
  const outputs = Object.keys(result.metafile.outputs);
  logger.log("📋 Built files:");
  outputs.forEach((output) => {
    const stats = fs.statSync(output);
    const sizeKB = (stats.size / 1024).toFixed(1);
    logger.log(`   ${output} (${sizeKB} KB)`);
  });
}

logger.log("✅ Build completed successfully");
