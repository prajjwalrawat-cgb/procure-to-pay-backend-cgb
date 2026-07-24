/**
 * Name-match fixtures (Slice 7 deliverable) — 30+ real-world Indian legal-name
 * variations. Each declares the two names, the expected acceptance outcome at
 * the default 0.85 threshold, and a note. Consumed by name-match.test.ts.
 */

export interface NameMatchFixture {
  a: string;
  b: string;
  expect: 'PASS' | 'FLAG';
  note: string;
}

export const NAME_MATCH_FIXTURES: NameMatchFixture[] = [
  // ── exact / trivially equal ──────────────────────────────────────────────
  { a: 'Patel Engineering', b: 'Patel Engineering', expect: 'PASS', note: 'exact' },
  { a: 'PATEL ENGINEERING', b: 'patel engineering', expect: 'PASS', note: 'case only' },
  {
    a: '  Patel   Engineering ',
    b: 'Patel Engineering',
    expect: 'PASS',
    note: 'whitespace',
  },

  // ── legal-suffix normalisation ───────────────────────────────────────────
  {
    a: 'Northeast Machining Works Pvt Ltd',
    b: 'Northeast Machining Works Private Limited',
    expect: 'PASS',
    note: 'pvt ltd vs private limited',
  },
  {
    a: 'Tata Steel Ltd',
    b: 'Tata Steel Limited',
    expect: 'PASS',
    note: 'ltd vs limited',
  },
  {
    a: 'Bhilai Steel Spares LLP',
    b: 'Bhilai Steel Spares',
    expect: 'PASS',
    note: 'llp stripped',
  },
  {
    a: 'Suraksha Chem Industries',
    b: 'Suraksha Chem',
    expect: 'PASS',
    note: 'industries stripped',
  },
  {
    a: 'Continental Belt Enterprises',
    b: 'Continental Belt',
    expect: 'PASS',
    note: 'enterprises stripped',
  },
  {
    a: 'R. K. Traders',
    b: 'RK Traders',
    expect: 'PASS',
    note: 'dotted spacing vs joined initials',
  },
  { a: 'Mehta & Sons', b: 'Mehta and Sons', expect: 'PASS', note: 'ampersand vs and' },
  { a: 'Sharma & Co', b: 'Sharma and Company', expect: 'PASS', note: 'and co / company' },

  // ── punctuation / abbreviation ───────────────────────────────────────────
  {
    a: 'S.R.K. Refractories',
    b: 'SRK Refractories',
    expect: 'PASS',
    note: 'dotted initials',
  },
  {
    a: 'Precision-Castings Ltd',
    b: 'Precision Castings',
    expect: 'PASS',
    note: 'hyphen',
  },
  {
    a: 'Guwahati Alloys (India)',
    b: 'Guwahati Alloys',
    expect: 'PASS',
    note: 'parenthetical',
  },
  {
    a: 'M/s Assam Chemicals',
    b: 'Assam Chemicals',
    expect: 'FLAG',
    note: 'm/s prefix residue lowers score',
  },

  // ── common typos (should still PASS) ─────────────────────────────────────
  {
    a: 'Northeast Machining Works',
    b: 'Northeast Machning Works',
    expect: 'PASS',
    note: 'single-char typo',
  },
  {
    a: 'Meghalaya Aggregates',
    b: 'Meghalya Aggregates',
    expect: 'PASS',
    note: 'missing char',
  },
  {
    a: 'Silchar Refractories',
    b: 'Silchar Refractoires',
    expect: 'PASS',
    note: 'transposition',
  },
  {
    a: 'Bengal Steel Trading',
    b: 'Bengal Steel',
    expect: 'PASS',
    note: 'trading suffix',
  },
  {
    a: 'Kalpesh Patel',
    b: 'Kalpes Patel',
    expect: 'PASS',
    note: 'single missing char in full name — strong match',
  },

  // ── word-order / partial ─────────────────────────────────────────────────
  {
    a: 'Patel Engineering Works',
    b: 'Works Engineering Patel',
    expect: 'FLAG',
    note: 'reordered words',
  },
  {
    a: 'Odisha Cement Additives',
    b: 'Odisha Additives',
    expect: 'PASS',
    note: 'shared prefix, dropped middle word',
  },
  {
    a: 'Northeast Logistics',
    b: 'Northeast Logistics Solutions',
    expect: 'PASS',
    note: 'proper prefix + extra word',
  },

  // ── genuinely different (must FLAG) ──────────────────────────────────────
  { a: 'Patel Engineering', b: 'Tata Steel', expect: 'FLAG', note: 'unrelated' },
  { a: 'Assam Chemicals', b: 'Kerala Fertilisers', expect: 'FLAG', note: 'unrelated' },
  {
    a: 'BPCL Industrial',
    b: 'HPCL Industrial',
    expect: 'FLAG',
    note: 'one-letter brand diff, distinct entities',
  },
  { a: 'JK Paper Mills', b: 'JP Power', expect: 'FLAG', note: 'unrelated' },

  // ── transliteration / spelling variants ──────────────────────────────────
  {
    a: 'Lakshmi Steels',
    b: 'Laxmi Steels',
    expect: 'FLAG',
    note: 'lakshmi/laxmi transliteration — below threshold, manual review',
  },
  {
    a: 'Krishna Traders',
    b: 'Krishnaa Traders',
    expect: 'PASS',
    note: 'double vowel variant',
  },
  { a: 'Vishwakarma Works', b: 'Vishwakarama Works', expect: 'PASS', note: 'extra a' },
  {
    a: 'Shree Ram Industries',
    b: 'Sri Ram Industries',
    expect: 'PASS',
    note: 'shree/sri',
  },

  // ── holder-name vs entity (banking) ──────────────────────────────────────
  {
    a: 'Northeast Machining Works Pvt Ltd',
    b: 'Northeast Machining Works Pvt Ltd',
    expect: 'PASS',
    note: 'penny-drop exact (spec demo)',
  },
  {
    a: 'Precision Castings Ltd',
    b: 'Precission Castings',
    expect: 'PASS',
    note: 'double-s typo',
  },
];
