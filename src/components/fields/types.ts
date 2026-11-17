import type {
  FormFieldMapping,
  FormFileUploadConfig,
  FormValidationRule,
} from '../../types';

/**
 * The properties FormField and SurveyQuestion already hold in common.
 *
 * Both types independently grew the same ~27 optional properties because the survey
 * builder began as a copy of the form builder. Rather than change either exported
 * type (they have a lot of consumers), this describes the overlap so the shared
 * editors below can be generic over "a field-ish thing" and both concrete types
 * satisfy it structurally, with no cast at the call sites.
 *
 * `options` is deliberately absent: FormFieldOption is { label, value } while
 * SurveyQuestionOption adds id and score. Components that need options take them
 * as an explicit prop instead.
 */
export interface BaseFieldConfig {
  id: string;
  /** FormFieldType | SurveyQuestionType — widened, since the sets only partly overlap. */
  type: string;
  label: string;
  required: boolean;
  // NOTE: `id` and `type` are read-only from a shared editor's point of view — see
  // FieldUpdate below, which excludes them. Widening `type` to string is what lets one
  // component serve both vocabularies, but it must never appear in an update payload or a
  // `Partial<BaseFieldConfig>` stops being assignable to `Partial<FormField>`
  // (string is not assignable to FormFieldType).
  placeholder?: string;
  defaultValue?: string;
  mapping?: FormFieldMapping;
  characterLimit?: number;
  fileUploadConfig?: FormFileUploadConfig;
  currency?: string;
  htmlContent?: string;
  formula?: string;
  columnCount?: 2 | 3 | 4;
  productIds?: string[];
  labelAlignment?: 'top' | 'left' | 'inline';
  optionsLayout?: 'vertical' | 'horizontal' | 'columns_2' | 'columns_3';
  validationRules?: FormValidationRule[];
  phoneFormat?: 'us' | 'international';
  addressAutoComplete?: boolean;
  addressMandatorySelect?: boolean;
  validateDeliverability?: boolean;
  allowOther?: boolean;
  minSelections?: number;
  maxSelections?: number;
  signaturePadHeight?: number;
  allowMultiple?: boolean;
  hiddenParamKey?: string;
  consentDescription?: string;
  headingLevel?: 'h1' | 'h2' | 'h3' | 'h4';
  customClassName?: string;
  customWidthPercent?: number;
}

/**
 * What a shared editor is allowed to write back.
 *
 * Deliberately excludes `id` and `type`: those identify the field, they are not settings, and
 * no shared control edits them. Excluding them is also what makes the type sound — every
 * remaining property exists on BOTH FormField and SurveyQuestion with an identical type, so
 * `Partial<FieldUpdate>` is assignable to `Partial<FormField>` and `Partial<SurveyQuestion>`
 * alike. Leaving `type: string` in the payload broke that (string vs FormFieldType) and made
 * every call site an error under strictFunctionTypes.
 */
export type FieldUpdate = Partial<Omit<BaseFieldConfig, 'id' | 'type'>>;

/**
 * Which validation rules apply to a given field/question type.
 *
 * Covers both vocabularies at once — forms call a single-line input `text` and
 * surveys call it `short_answer`, but they want identical rules. A form never sees
 * `short_answer` and a survey never sees `text`, so carrying both is harmless.
 */
const TEXT_LIKE = new Set([
  'text',
  'textarea',
  'short_answer',
  'long_answer',
  'first_name',
  'last_name',
  'full_name',
  'company',
  'address',
  'city',
  'state',
  'postal_code',
  'source',
]);

export function availableValidationRules(
  type: string
): { type: FormValidationRule['type']; label: string }[] {
  const rules: { type: FormValidationRule['type']; label: string }[] = [];

  if (TEXT_LIKE.has(type)) {
    rules.push({ type: 'min_length', label: 'Minimum Length' });
    rules.push({ type: 'max_length', label: 'Maximum Length' });
    rules.push({ type: 'pattern', label: 'Regex Pattern' });
  }
  if (type === 'number' || type === 'monetary') {
    rules.push({ type: 'min', label: 'Minimum Value' });
    rules.push({ type: 'max', label: 'Maximum Value' });
  }
  if (type === 'date') {
    rules.push({ type: 'min_date', label: 'Earliest Date' });
    rules.push({ type: 'max_date', label: 'Latest Date' });
  }
  if (type === 'email' || type === 'phone' || type === 'website') {
    rules.push({ type: 'format', label: 'Strict format check' });
  }

  return rules;
}
