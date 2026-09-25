#!/usr/bin/env node
// PHA-3798: produce dist/*.js so npm:/npm-pack:/git: plugin installs work.
//
// --link is the only OpenClaw install kind that accepts a raw .ts
// `openclaw.extensions` entry (package-entry-resolution.ts upstream, gated
// off `request.link` in management-install.ts). Every other install kind
// requires a compiled dist/<name>.js next to it — OpenClaw infers that
// counterpart automatically from the .ts entry already declared in
// package.json, so this script does not touch openclaw.extensions.
//
// Transpile only, no type-checking: index.ts and src/channel.ts import
// openclaw/plugin-sdk subpaths (channel-entry-contract, channel-core,
// realtime-bootstrap-context, routing) that tsconfig.json's standalone stub
// set does not model, which is why tsconfig.json's own `exclude` list
// already keeps those two files out of `npm run typecheck` (PHA-3787).
// Building them against the stubs would just fail on the same gaps for a
// different reason. esbuild strips types without resolving them, which
// matches that existing, documented gap rather than papering over it with
// a possibly-wrong stub. The `openclaw/plugin-sdk/*` import specifiers
// themselves pass through untouched either way — esbuild only transforms
// syntax, it does not bundle or rewrite bare specifiers — so at runtime
// they still resolve against the real running gateway's own package
// (plugin-peer-link.ts upstream), same as an unbuilt --link install.
import { build } from "esbuild";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

rmSync("dist", { recursive: true, force: true });

const entryPoints = [
  "index.ts",
  "channel-plugin-api.ts",
  "runtime-setter-api.ts",
  ...collectTsFiles("src"),
];

await build({
  entryPoints,
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "info",
});
