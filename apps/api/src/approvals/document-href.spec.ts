import { DOCUMENT_TYPE } from '@procureflow/shared';
import { describe, expect, it } from 'vitest';

import { documentHref } from './document-href';

describe('documentHref', () => {
  it('sends a routed vendor onboarding to its review page', () => {
    // The regression: the inbox used to build `/vendor_onboarding/vob_1`, so
    // the row was listed but 404'd when the approver clicked Open.
    expect(documentHref('VENDOR_ONBOARDING', 'vob_1')).toBe('/vendors/onboarding/vob_1');
  });

  it('never falls back to the raw `/<type>/<id>` shape', () => {
    // That fallback is what produced the 404 — it invents a route from the
    // enum name instead of naming a page that exists.
    for (const type of DOCUMENT_TYPE) {
      expect(documentHref(type, 'doc_1')).not.toBe(`/${type.toLowerCase()}/doc_1`);
    }
  });

  it('covers every routable document type with an absolute path', () => {
    for (const type of DOCUMENT_TYPE) {
      expect(documentHref(type, 'doc_1')).toMatch(/^\/[a-z]/);
    }
  });
});
