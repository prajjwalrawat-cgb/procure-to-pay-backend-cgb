import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../sha256';
import { getBankFormatter } from '../registry';
import type { BankFileInput, BankFormatKey } from '../types';
import { GOLDEN_FIXTURES } from './fixtures';

interface Golden {
  name: string;
  formatKey: BankFormatKey;
  input: BankFileInput;
  expected: { content: string; checksum: string; rowCount: number };
}

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'golden');

function loadGolden(name: string): Golden {
  return JSON.parse(readFileSync(join(goldenDir, `${name}.json`), 'utf8')) as Golden;
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 known-answer for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the known-answer for the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('bank-file golden files (byte-for-byte)', () => {
  // At least 5 golden cases per format (Slice 3 verification checklist).
  const perFormat: Record<string, number> = {};
  for (const fx of GOLDEN_FIXTURES) {
    perFormat[fx.formatKey] = (perFormat[fx.formatKey] ?? 0) + 1;
  }

  it('has ≥5 golden cases for each of HDFC/ICICI/SBI', () => {
    expect(perFormat.NEFT_BULK).toBeGreaterThanOrEqual(5);
    expect(perFormat.ICICI_CINB).toBeGreaterThanOrEqual(5);
    expect(perFormat.SBI_CINB).toBeGreaterThanOrEqual(5);
  });

  for (const fx of GOLDEN_FIXTURES) {
    it(`${fx.name} renders byte-identical to its golden`, () => {
      const golden = loadGolden(fx.name);
      const out = getBankFormatter(fx.formatKey).format(fx.input);
      // Byte-for-byte on the exact content (line endings included).
      expect(out.content).toBe(golden.expected.content);
      expect(out.rowCount).toBe(golden.expected.rowCount);
      // Checksum is stable and consistent with the bytes.
      expect(out.checksum).toBe(golden.expected.checksum);
      expect(out.checksum).toBe(sha256Hex(out.content));
    });
  }
});

describe('formatter shape', () => {
  it('HDFC uses CRLF with a trailing CRLF and header/trailer rows', () => {
    const out = getBankFormatter('NEFT_BULK').format(GOLDEN_FIXTURES[0]!.input);
    expect(out.content.endsWith('\r\n')).toBe(true);
    expect(out.content.split('\r\n')[0]!.startsWith('H,STAR01,')).toBe(true);
    expect(out.content).toContain('\r\nT,');
  });

  it('ICICI is LF-terminated with a named-column header', () => {
    const out = getBankFormatter('ICICI_CINB').format({
      meta: GOLDEN_FIXTURES[0]!.input.meta,
      payees: GOLDEN_FIXTURES[0]!.input.payees,
    });
    expect(out.content.includes('\r')).toBe(false);
    expect(out.content.startsWith('PYMT_MODE,BENE_NAME,')).toBe(true);
  });

  it('rejects an unknown / CUSTOM format', () => {
    expect(() => getBankFormatter('CUSTOM')).toThrow(/Unsupported bank file format/);
  });
});
