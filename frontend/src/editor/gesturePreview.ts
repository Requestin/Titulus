import type { Transform } from '@runtime';
import { createStore } from 'zustand/vanilla';

export interface GesturePreview {
  id: string;
  kind: 'layer' | 'group';
  transform: Transform;
}

interface GesturePreviewState {
  preview: GesturePreview | null;
}

export const gesturePreviewStore = createStore<GesturePreviewState>()(() => ({
  preview: null,
}));

let pendingPreview: GesturePreview | null = null;
let frameRequest: number | null = null;

export function publishGesturePreview(preview: GesturePreview): void {
  gesturePreviewStore.setState({ preview });
}

export function scheduleGesturePreview(preview: GesturePreview): void {
  pendingPreview = preview;
  if (frameRequest !== null) return;

  frameRequest = requestAnimationFrame(() => {
    frameRequest = null;
    if (!pendingPreview) return;
    publishGesturePreview(pendingPreview);
    pendingPreview = null;
  });
}

export function clearGesturePreview(): void {
  pendingPreview = null;
  if (frameRequest !== null) {
    cancelAnimationFrame(frameRequest);
    frameRequest = null;
  }
  gesturePreviewStore.setState({ preview: null });
}
