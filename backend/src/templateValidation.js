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
 * @returns {{ valid: boolean, errors: Array<{path:string,message:string,keyword?:string,schemaPath?:string,params?:unknown}> }}
 */
export function validateTemplate(template) {
  const valid = validateFn(template);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors || []).map((e) => ({
    path: e.instancePath || '/',
    message: formatAjvMessage(e),
    keyword: e.keyword,
    schemaPath: e.schemaPath,
    params: e.params,
  }));
  return { valid: false, errors };
}

function formatAjvMessage(e) {
  const base = e.message || 'invalid';
  if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
    return `must NOT have additional property "${e.params.additionalProperty}"`;
  }
  if (e.keyword === 'required' && e.params?.missingProperty) {
    return `missing required property "${e.params.missingProperty}"`;
  }
  if (e.keyword === 'enum' && Array.isArray(e.params?.allowedValues)) {
    return `${base} (allowed: ${e.params.allowedValues.join(', ')})`;
  }
  if (e.keyword === 'type' && e.params?.type) {
    return `must be ${e.params.type}`;
  }
  return base;
}

/** Human-readable one-line summary for toasts / ApiError.message. */
export function formatValidationErrorsSummary(errors, { limit = 3 } = {}) {
  if (!Array.isArray(errors) || errors.length === 0) return 'template validation failed';
  const parts = errors.slice(0, limit).map((e) => {
    const path = e.path && e.path !== '/' ? e.path : '(root)';
    return `${path}: ${e.message || 'invalid'}`;
  });
  const more = errors.length > limit ? ` (+${errors.length - limit} more)` : '';
  return `template validation failed — ${parts.join('; ')}${more}`;
}

export function templateValidationErrorPayload(errors, {
  code = 'TEMPLATE_VALIDATION_FAILED',
  message,
} = {}) {
  const list = Array.isArray(errors) ? errors : [];
  return {
    code,
    message: message || formatValidationErrorsSummary(list),
    details: {
      count: list.length,
      errors: list,
    },
  };
}

export { schema };
