import { createStore } from 'zustand/vanilla';
import type { TimelineSample } from '@runtime';

/**
 * Mirrors TemplateRenderer.getLastTimelineSample() so overlay / property
 * sampling can match the painted canvas (director-machine locals while
 * playing; seek sample while scrubbing).
 */
export const timelineSampleStore = createStore<{ sample: TimelineSample | null }>()(() => ({
  sample: null,
}));

export function publishTimelineSample(sample: TimelineSample | null): void {
  timelineSampleStore.setState({ sample });
}
