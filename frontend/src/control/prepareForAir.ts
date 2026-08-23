import type { Template } from '@runtime';
import { api } from '@/core/api';

export type PrepareTrigger = 'take' | 'load' | 'update' | 'refresh';

export async function prepareForAir(
  template: Template,
  trigger: PrepareTrigger,
  variables?: Record<string, string | number>,
) {
  return api.templates.prepare({ template, trigger, variables });
}
