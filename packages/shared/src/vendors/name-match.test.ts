import { describe, expect, it } from 'vitest';

import {
  assessAcceptance,
  compare,
  jaroWinkler,
  levenshteinScore,
  normaliseName,
} from './name-match';
import { NAME_MATCH_FIXTURES } from './__tests__/name-match-fixtures';

describe('normaliseName', () => {
  it('uppercases, strips suffixes, collapses whitespace', () => {
    expect(normaliseName('  Patel   Engineering Pvt. Ltd. ')).toBe('PATEL ENGINEERING');
  });
  it('normalises Private Limited to nothing', () => {
    expect(normaliseName('Tata Steel Private Limited')).toBe('TATA STEEL');
  });
  it('handles ampersand and sons', () => {
    expect(normaliseName('Mehta & Sons')).toBe('MEHTA');
    expect(normaliseName('Mehta and Sons')).toBe('MEHTA');
  });
  it('strips dotted initials punctuation', () => {
    expect(normaliseName('S.R.K. Refractories')).toBe('S R K REFRACTORIES');
  });
});

describe('compare — hybrid', () => {
  it('scores identical names 1.0', () => {
    expect(compare('Patel Engineering', 'Patel Engineering').score).toBe(1);
  });
  it('scores Pvt Ltd vs Private Limited near 1.0', () => {
    const r = compare('Northeast Works Pvt Ltd', 'Northeast Works Private Limited');
    expect(r.score).toBeGreaterThanOrEqual(0.95);
  });
  it('scores unrelated names low', () => {
    expect(compare('Patel Engineering', 'Tata Steel').score).toBeLessThan(0.6);
  });
});

describe('assessAcceptance', () => {
  it('passes at/above threshold', () => {
    expect(assessAcceptance(0.85).pass).toBe(true);
    expect(assessAcceptance(0.9).recommendation).toBe('PASS');
  });
  it('flags below threshold', () => {
    expect(assessAcceptance(0.82).pass).toBe(false);
    expect(assessAcceptance(0.82).recommendation).toBe('FLAG');
  });
  it('honours a tenant-override threshold', () => {
    expect(assessAcceptance(0.82, 0.8).pass).toBe(true);
  });
  it('penny-drop mismatch (different holder name) flags at 0.85', () => {
    // A genuinely different declared-vs-registered holder name must FLAG.
    const { score } = compare('Kalpesh Patel', 'Rajesh Kumar');
    expect(assessAcceptance(score).pass).toBe(false);
  });
});

describe('algorithm variants', () => {
  it('jaro-winkler boosts common prefixes', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeGreaterThan(0.9);
  });
  it('levenshtein score is 1 for identical', () => {
    expect(levenshteinScore('ABC', 'ABC')).toBe(1);
  });
});

describe('fixtures — 30+ real-world Indian legal-name variations', () => {
  it('has at least 30 fixtures', () => {
    expect(NAME_MATCH_FIXTURES.length).toBeGreaterThanOrEqual(30);
  });
  for (const f of NAME_MATCH_FIXTURES) {
    it(`${f.expect}: ${f.a} ~ ${f.b} (${f.note})`, () => {
      const { score } = compare(f.a, f.b);
      const { pass } = assessAcceptance(score);
      expect(pass ? 'PASS' : 'FLAG').toBe(f.expect);
    });
  }
});
