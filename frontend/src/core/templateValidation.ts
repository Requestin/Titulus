import { ApiError, type ValidationError } from './api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isValidationError(value: unknown): value is ValidationError {
  return isRecord(value)
    && typeof value.path === 'string'
    && typeof value.message === 'string';
}

export function extractTemplateValidationErrors(error: unknown): ValidationError[] {
  if (!(error instanceof ApiError) || error.status !== 422) return [];

  try {
    const body = error.body;
    if (!isRecord(body) || !isRecord(body.error)
        || body.error.code !== 'TEMPLATE_VALIDATION_FAILED') return [];
    const details = body.error.details;
    if (!isRecord(details) || !Array.isArray(details.errors)) return [];
    return details.errors.filter(isValidationError);
  } catch {
    return [];
  }
}

export function formatTemplateValidationError(errors: readonly ValidationError[]): string {
  const first = errors[0];
  return first ? `${first.path}: ${first.message}` : 'invalid template';
}
