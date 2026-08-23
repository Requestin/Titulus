import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface PlayheadState {
  playhead: number;
  playing: boolean;
}

export const playheadStore = createStore<PlayheadState>()(() => ({
  playhead: 0,
  playing: false,
}));

export function usePlayhead<T>(select: (state: PlayheadState) => T): T {
  return useStore(playheadStore, select);
}

export function setLivePlayhead(frame: number): void {
  playheadStore.setState({ playhead: Math.max(0, Math.round(frame)) });
}

export function setLivePlaying(playing: boolean): void {
  playheadStore.setState({ playing });
}

export function syncPlayhead(frame: number, playing = playheadStore.getState().playing): void {
  playheadStore.setState({ playhead: Math.max(0, Math.round(frame)), playing });
}
