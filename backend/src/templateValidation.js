// backend/src/templateValidation.js
//
// JSON Schema validation for templates (DEVELOPMENT_PROMPT §7.3, REQ-9).
// Loads shared/template.schema.json once and compiles an ajv validator.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, '../../shared/template.schema.json');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateFn = ajv.compile(schema);

/**
 * Validate a template object against the schema.
 * @returns {{ valid: boolean, errors: Array<{path:string,message:string}> }}
 */
export function validateTemplate(template) {
  const valid = validateFn(template);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors || []).map((e) => ({
    path: e.instancePath || e.schemaPath || '/',
    message: e.message || 'invalid',
    keyword: e.keyword,
    schemaPath: e.schemaPath,
    params: e.params,
  }));
  return { valid: false, errors };
}

export function templateValidationErrorPayload(errors, {
  code = 'TEMPLATE_VALIDATION_FAILED',
  message = 'template validation failed',
} = {}) {
  return {
    code,
    message,
    details: {
      count: Array.isArray(errors) ? errors.length : 0,
      errors: Array.isArray(errors) ? errors : [],
    },
  };
}

export { schema };
