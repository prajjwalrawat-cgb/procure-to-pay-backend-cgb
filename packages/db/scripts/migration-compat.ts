/**
 * Migration backward-compatibility gate (Slice 11c).
 *
 * A rolling deploy runs the NEW schema against the STILL-RUNNING OLD API for a
 * window. Migrations must therefore be backward-compatible with the currently
 * deployed code (the expand/contract discipline): destructive DDL — DROP COLUMN,
 * DROP TABLE, RENAME, SET NOT NULL without a default, type narrowing — breaks the
 * old app mid-deploy and must be split across releases (expand, deploy, then
 * contract in a later release).
 *
 * This gate scans migrations added on this branch vs a base ref and FAILS CI
 * (exit 1) on any unacknowledged destructive statement. An intentional
 * contract-phase migration acknowledges itself with a comment on the line above:
 *   -- migration-compat: allow (expand/contract phase 2 — old column unused since vX)
 *
 * Usage:  BASE_REF=origin/main pnpm --filter @procureflow/db migration:compat
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve the repo root so the gate works regardless of cwd (pnpm --filter runs
// it from packages/db). Fall back to two levels up from this script.
function repoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return join(__dirname, '..', '..', '..');
  }
}

const ROOT = repoRoot();
const MIGRATIONS_DIR = 'packages/db/prisma/migrations';
const ALLOW = /--\s*migration-compat:\s*allow/i;
const git = (cmd: string): string =>
  execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });

interface Rule {
  id: string;
  re: RegExp;
  why: string;
}

// Destructive DDL that a still-running previous app version cannot tolerate.
const RULES: Rule[] = [
  { id: 'drop-table', re: /\bDROP\s+TABLE\b/i, why: 'old app still reads this table' },
  {
    id: 'drop-column',
    re: /\bDROP\s+COLUMN\b/i,
    why: 'old app still selects/inserts this column',
  },
  {
    id: 'rename-column',
    re: /\bRENAME\s+COLUMN\b/i,
    why: 'old app references the old name',
  },
  {
    id: 'rename-table',
    re: /\bALTER\s+TABLE\s+.+\bRENAME\s+TO\b/i,
    why: 'old app references the old name',
  },
  {
    id: 'set-not-null',
    re: /\bALTER\s+COLUMN\b.+\bSET\s+NOT\s+NULL\b/i,
    why: 'old app may insert NULL; add a default + backfill first',
  },
  {
    id: 'type-change',
    re: /\bALTER\s+COLUMN\b.+\b(TYPE|USING)\b/i,
    why: 'type change can break the old app; expand with a new column instead',
  },
  {
    id: 'drop-default',
    re: /\bALTER\s+COLUMN\b.+\bDROP\s+DEFAULT\b/i,
    why: 'old app relies on the DB default',
  },
];

function changedMigrationFiles(): string[] {
  const base = process.env.BASE_REF ?? 'origin/main';
  const files = new Set<string>();
  const add = (out: string): void => {
    out
      .split('\n')
      .filter((f) => f.endsWith('migration.sql'))
      .forEach((f) => files.add(join(ROOT, f)));
  };
  try {
    add(git(`git diff --name-only --diff-filter=AM ${base}...HEAD -- ${MIGRATIONS_DIR}`));
  } catch {
    /* bad/missing base ref — untracked scan + fallback below still run */
  }
  try {
    add(git(`git ls-files --others --exclude-standard -- ${MIGRATIONS_DIR}`));
  } catch {
    /* not a git repo — fall back to the most recent migration folder */
    const absDir = join(ROOT, MIGRATIONS_DIR);
    if (existsSync(absDir)) {
      const dirs = readdirSync(absDir)
        .filter((d) => /^\d/.test(d))
        .sort();
      const last = dirs[dirs.length - 1];
      if (last) files.add(join(absDir, last, 'migration.sql'));
    }
  }
  return [...files].filter((f) => existsSync(f));
}

function main(): void {
  const files = changedMigrationFiles();
  if (files.length === 0) {
    console.log('migration:compat — no new migrations to check. ✅');
    return;
  }
  console.log(`migration:compat — scanning ${files.length} migration(s):\n`);
  let violations = 0;

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const acknowledged = ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? '');
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          const flag = acknowledged ? '🟡 allowed' : '❌ BLOCK';
          if (!acknowledged) violations += 1;
          console.log(`  ${flag} [${rule.id}] ${file}:${i + 1}`);
          console.log(`        ${line.trim()}`);
          if (!acknowledged)
            console.log(`        → ${rule.why}. Split expand/contract or annotate.`);
        }
      }
    });
  }

  if (violations === 0) {
    console.log('\n✅ all migrations backward-compatible (or acknowledged).');
    process.exit(0);
  }
  console.log(
    `\n❌ ${violations} backward-incompatible statement(s). See the expand/contract note above.`,
  );
  process.exit(1);
}

main();
