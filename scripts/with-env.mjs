#!/usr/bin/env node
// Loads the repo-root `.env` into process.env, then runs the command passed as
// arguments. Used by the root `db:*` / `audit:verify` scripts so the Prisma CLI
// (which only reads .env from its own cwd) and the tsx seed/security scripts all
// see DATABASE_URL / DIRECT_DATABASE_URL without exporting them each session.
//
// Dependency-free. Existing process.env values win (so CI overrides still apply).
// For a single local DB, DIRECT_DATABASE_URL falls back to DATABASE_URL.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// migrate CLI needs directUrl; for a single local DB it's the same connection.
if (!process.env.DIRECT_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL;
}

const cmd = process.argv.slice(2);
if (cmd.length === 0) {
  console.error('with-env: no command given');
  process.exit(1);
}

const child = spawn(cmd.join(' '), {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
