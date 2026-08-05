/**
 * GST state codes — the 2-digit codes that open every GSTIN and that
 * `determineTaxKind` (tax.ts) compares to decide CGST+SGST vs IGST. A wrong but
 * well-formed code fails silently: the invoice simply carries the wrong tax
 * heads. That's the reason vendors pick from this list rather than typing.
 *
 * Codes 25 (Daman & Diu) and 28 (undivided Andhra Pradesh) were retired — 25/26
 * merged into "Dadra & Nagar Haveli and Daman & Diu", and 28 split into 37
 * (Andhra Pradesh) and 36 (Telangana). They stay listed as `retired` so historic
 * vendor records still resolve to a name, while pickers can filter them out.
 */
export interface GstState {
  code: string;
  name: string;
  /** No longer issued; present only so old records still render a name. */
  retired?: true;
}

export const GST_STATES: readonly GstState[] = [
  { code: '01', name: 'Jammu & Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '25', name: 'Daman & Diu', retired: true },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '28', name: 'Andhra Pradesh (undivided)', retired: true },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman & Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
];

/** Codes offered for new input — retired ones are readable but not selectable. */
export const SELECTABLE_GST_STATES: readonly GstState[] = GST_STATES.filter(
  (s) => !s.retired,
);

const BY_CODE = new Map(GST_STATES.map((s) => [s.code, s]));

/** "07" → "Delhi". Returns null for anything not a known code. */
export function gstStateName(code: string | null | undefined): string | null {
  return code ? (BY_CODE.get(code)?.name ?? null) : null;
}

/** "07" → "07 — Delhi", falling back to the bare code when unrecognised. */
export function formatGstState(code: string | null | undefined): string {
  if (!code) return '—';
  const name = gstStateName(code);
  return name ? `${code} — ${name}` : code;
}
