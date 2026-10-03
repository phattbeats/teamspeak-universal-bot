#!/usr/bin/env node
// PHA-3791: run a command with a docker-style env file: KEY=VALUE per line,
// taken literally. Not `. file` in sh: the Suno cookie is full of `;` and `$`,
// which a shell would split and expand (docker --env-file never did).
//   node env-exec.mjs <env-file> <command> [args...]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [file, cmd, ...args] = process.argv.slice(2);
const env = { ...process.env };
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2];
}
const child = spawn(cmd, args, { env, stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
