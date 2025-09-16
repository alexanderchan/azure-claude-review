import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/claude-review.ts"],
    outDir: "./bin",
    platform: "node",
    dts: true,
    format: "commonjs",
  },
]);
