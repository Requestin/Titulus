// backend/src/templateValidation.js
//
// JSON Schema and production air validation for templates.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { classifyTemplateCapabilities } from '../../shared/templateCapabilities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, '../../shared/template.schema.json');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateFn = ajv.compile(schema);

/**
 * Validate only the persisted template schema. Capability support is not
 * considered here; production persistence and air boundaries use the
 * fail-closed validator below.
 * @returns {{ valid: boolean, errors: Array<object> }}
 */
export function validateTemplateSchema(template) {
  const valid = validateFn(template);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors || []).map((error) => ({
    path: error.instancePath || error.schemaPath || '/',
    message: error.message || 'invalid',
    keyword: error.keyword,
    schemaPath: error.schemaPath,
    params: error.params,
  }));
  return { valid: false, errors };
}

/**
 * Production validation used at every boundary that can put a template on air.
 * Schema validation deliberately runs first; malformed templates never reach
 * capability classification.
 */
export function validateTemplateForAir(template) {
  const schemaResult = validateTemplateSchema(template);
  if (!schemaResult.valid) return schemaResult;

  let classification;
  try {
    classification = classifyTemplateCapabilities(template);
  } catch (error) {
    return {
      valid: false,
      errors: [{
        path: '/capabilities',
        code: 'TEMPLATE_CAPABILITY_CLASSIFICATION_FAILED',
        message: error instanceof Error ? error.message : 'template capability classification failed',
      }],
    };
  }

  if (!classification.airCompatible) {
    const supported = new Set(classification.supported || []);
    const unsupported = (classification.required || [])
      .filter((capability) => !supported.has(capability));
    return {
      valid: false,
      errors: [{
        path: '/capabilities',
        code: 'UNSUPPORTED_TEMPLATE_CAPABILITY',
        message: `unsupported template capabilities: ${unsupported.join(', ')}`,
        capabilities: unsupported,
      }],
    };
  }

  return { valid: true, errors: [] };
}

// Existing callers are production boundaries, so preserve the historical name
// as a wrapper around the fail-closed air validator.
export function validateTemplate(template) {
  return validateTemplateForAir(template);
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
