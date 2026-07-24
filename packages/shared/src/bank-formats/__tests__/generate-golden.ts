/**
 * Regenerates the committed golden files from `fixtures.ts`. Run explicitly when
 * a formatter's output is intentionally changed:
 *   pnpm --filter @procureflow/shared exec tsx src/bank-formats/__tests__/generate-golden.ts
 * The golden test then guards the committed output against unintended drift.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBankFormatter } from '../registry';
import { GOLDEN_FIXTURES } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'golden');
mkdirSync(goldenDir, { recursive: true });

for (const fx of GOLDEN_FIXTURES) {
  const out = getBankFormatter(fx.formatKey).format(fx.input);
  const golden = {
    name: fx.name,
    formatKey: fx.formatKey,
    input: fx.input,
    expected: { content: out.content, checksum: out.checksum, rowCount: out.rowCount },
  };
  writeFileSync(
    join(goldenDir, `${fx.name}.json`),
    JSON.stringify(golden, null, 2) + '\n',
  );
  process.stdout.write(`  wrote golden/${fx.name}.json\n`);
}

process.stdout.write(`Generated ${GOLDEN_FIXTURES.length} golden files.\n`);
