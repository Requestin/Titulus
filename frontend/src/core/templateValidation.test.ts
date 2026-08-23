import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ValidationError } from './api';
import {
  extractTemplateValidationErrors,
  formatTemplateValidationError,
} from './templateValidation';

test('extracts schema errors from the /validate ApiError response', () => {
  const errors: ValidationError[] = [{
    path: '/layers/0/type',
    message: 'must be equal to one of the allowed values',
    keyword: 'enum',
    schemaPath: '#/$defs/layer/properties/type/enum',
    params: { allowedValues: ['text', 'image'] },
  }];
  const error = new ApiError(422, 'template validation failed', {
    valid: false,
    error: {
      code: 'TEMPLATE_VALIDATION_FAILED',
      message: 'template validation failed',
      details: { count: errors.length, errors },
    },
  });

  assert.deepEqual(extractTemplateValidationErrors(error), errors);
});

test('extracts create/update capability errors without dropping classifier details', () => {
  const errors = [{
    path: '/capabilities',
    message: 'unsupported template capabilities: crawl.layer, properties.position-z',
    code: 'UNSUPPORTED_TEMPLATE_CAPABILITY',
    capabilities: ['crawl.layer', 'properties.position-z'],
  }];
  const error = new ApiError(422, 'template validation failed', {
    error: {
      code: 'TEMPLATE_VALIDATION_FAILED',
      message: 'template validation failed',
      details: { count: errors.length, errors },
    },
  });

  const extracted = extractTemplateValidationErrors(error);

  assert.deepEqual(extracted, errors);
  assert.equal(extracted[0]?.code, 'UNSUPPORTED_TEMPLATE_CAPABILITY');
  assert.deepEqual(extracted[0]?.capabilities, ['crawl.layer', 'properties.position-z']);
});

test('ignores malformed entries and handles malformed or non-ApiError values safely', () => {
  const valid = { path: '/', message: 'must be object' };
  const mixed = new ApiError(422, 'template validation failed', {
    error: {
      details: {
        errors: [null, valid, { path: 1, message: true }, 'invalid'],
      },
    },
  });

  assert.deepEqual(extractTemplateValidationErrors(mixed), [valid]);

  const invalidValues: unknown[] = [
    null,
    undefined,
    new Error('network failed'),
    { body: mixed.body },
    new ApiError(422, 'bad body', null),
    new ApiError(422, 'bad details', { error: { details: null } }),
    new ApiError(422, 'bad errors', { error: { details: { errors: 'invalid' } } }),
  ];
  for (const value of invalidValues) {
    assert.deepEqual(extractTemplateValidationErrors(value), []);
  }
});

test('formats the first validation error with its path and message', () => {
  const errors = [
    { path: '/layers/0/type', message: 'must be equal to one of the allowed values' },
    { path: '/layers/1/src', message: 'must be string' },
  ];

  assert.equal(
    formatTemplateValidationError(errors),
    '/layers/0/type: must be equal to one of the allowed values',
  );
});

test('reads only validation diagnostics and never inspects or migrates template data', () => {
  let templateReads = 0;
  const errors = Object.freeze([
    Object.freeze({ path: '/actions', message: 'legacy actions require migration' }),
  ]);
  const body = {
    error: {
      details: {
        errors,
      },
    },
  };
  Object.defineProperty(body, 'data', {
    get() {
      templateReads += 1;
      throw new Error('frontend validation helper must not inspect template data');
    },
  });
  const error = new ApiError(422, 'template validation failed', Object.freeze(body));

  assert.deepEqual(extractTemplateValidationErrors(error), errors);
  assert.equal(templateReads, 0);
});
