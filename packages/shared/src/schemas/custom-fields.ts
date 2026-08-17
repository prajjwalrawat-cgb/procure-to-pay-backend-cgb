import { z } from 'zod';

/**
 * Admin-defined custom fields.
 *
 * An admin adds a field to a document type from Settings; every form for that
 * type then renders it, the value is stored on the document's own
 * `customFields` JSON, and printable fields appear on the PDF. No code change,
 * no migration — which is the whole point: the fields a business needs on a
 * requisition are its own, and cannot be enumerated up front.
 */

export const CUSTOM_FIELD_ENTITIES = [
  'REQUISITION',
  'PURCHASE_ORDER',
  'GOODS_RECEIPT',
  'INVOICE',
  'VENDOR',
  'ITEM',
] as const;
export const CustomFieldEntitySchema = z.enum(CUSTOM_FIELD_ENTITIES);
export type CustomFieldEntity = z.infer<typeof CustomFieldEntitySchema>;

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
] as const;
export const CustomFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;

/** Human labels for the admin UI and the document renderers. */
export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntity, string> = {
  REQUISITION: 'Requisition',
  PURCHASE_ORDER: 'Purchase order',
  GOODS_RECEIPT: 'Goods receipt',
  INVOICE: 'Invoice',
  VENDOR: 'Vendor',
  ITEM: 'Item',
};

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  TEXT: 'Text',
  TEXTAREA: 'Paragraph',
  NUMBER: 'Number',
  DATE: 'Date',
  SELECT: 'Dropdown',
  MULTI_SELECT: 'Multi-select',
  CHECKBOX: 'Checkbox',
};

/** Types whose `options` list is meaningful. */
export const CHOICE_FIELD_TYPES: CustomFieldType[] = ['SELECT', 'MULTI_SELECT'];

export const CustomFieldDefinitionSchema = z.object({
  id: z.string(),
  entityType: CustomFieldEntitySchema,
  key: z.string(),
  label: z.string(),
  fieldType: CustomFieldTypeSchema,
  options: z.array(z.string()),
  isRequired: z.boolean(),
  isPrintable: z.boolean(),
  helpText: z.string().nullable(),
  orderNo: z.number().int(),
  isActive: z.boolean(),
});
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinitionSchema>;

const optionList = z
  .array(z.string().trim().min(1).max(120))
  .max(50, 'A field can offer at most 50 choices')
  .optional();

export const CustomFieldCreateInputSchema = z
  .object({
    entityType: CustomFieldEntitySchema,
    label: z.string().trim().min(1, 'Label is required').max(80),
    fieldType: CustomFieldTypeSchema,
    options: optionList,
    isRequired: z.boolean().optional(),
    isPrintable: z.boolean().optional(),
    helpText: z.string().trim().max(200).nullish(),
  })
  .refine(
    (v) => !CHOICE_FIELD_TYPES.includes(v.fieldType) || (v.options?.length ?? 0) > 0,
    { message: 'Add at least one choice', path: ['options'] },
  );
export type CustomFieldCreateInput = z.infer<typeof CustomFieldCreateInputSchema>;

/** `key` and `entityType` are deliberately absent: changing either would
 *  orphan every value already captured under the old key. */
export const CustomFieldUpdateInputSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  options: optionList,
  isRequired: z.boolean().optional(),
  isPrintable: z.boolean().optional(),
  helpText: z.string().trim().max(200).nullish(),
  orderNo: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export type CustomFieldUpdateInput = z.infer<typeof CustomFieldUpdateInputSchema>;

/** Captured values, keyed by definition key. Shapes are validated server-side
 *  against the definitions, since the allowed keys are tenant data. */
export const CustomFieldValuesSchema = z.record(z.unknown());
export type CustomFieldValues = z.infer<typeof CustomFieldValuesSchema>;

/** "Project code" → "project_code". Keys are derived from the label once, at
 *  creation, then frozen. */
export function customFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** One captured value rendered for display (detail pages, PDF). */
export function formatCustomFieldValue(
  def: Pick<CustomFieldDefinition, 'fieldType'>,
  value: unknown,
): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (def.fieldType) {
    case 'CHECKBOX':
      return value ? 'Yes' : 'No';
    case 'MULTI_SELECT':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'DATE': {
      const iso = String(value).slice(0, 10);
      const [y, m, d] = iso.split('-');
      return d ? `${d}.${m}.${y}` : iso;
    }
    default:
      return String(value);
  }
}
