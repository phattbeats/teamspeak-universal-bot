/**
 * Standalone test harness.
 *
 * The plugin is written against `openclaw/plugin-sdk/*`, which only resolves
 * inside an OpenClaw checkout. This config aliases the one SDK subpath the
 * plugin imports to a local stand-in (test/sdk-stubs) so the roster, gating,
 * barge-in, codec, and command logic can be tested on their own.
 *
 * Inside an OpenClaw checkout, run the plugin's tests with the repository's own
 * vitest instead; this config is not used there and the real SDK resolves.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (name: string) => fileURLToPath(new URL(`./test/sdk-stubs/${name}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "openclaw/plugin-sdk/realtime-voice", replacement: stub("realtime-voice") },
      { find: "openclaw/plugin-sdk/config-contracts", replacement: stub("config-contracts") },
    ],
  },
  // tsconfig.json here is the upstream one, which extends a base that only
  // exists inside an OpenClaw checkout. Give esbuild its options directly so
  // the standalone run does not try to resolve that base.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: "es2023",
        useDefineForClassFields: true,
        verbatimModuleSyntax: true,
      },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
