import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface PlayheadState {
  playhead: number;
  playing: boolean;
  continueRequestId: number;
  waitingContinue: boolean;
}

export const playheadStore = createStore<PlayheadState>()(() => ({
  playhead: 0,
  playing: false,
  continueRequestId: 0,
  waitingContinue: false,
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

export function requestContinue(): void {
  playheadStore.setState((state) => ({ continueRequestId: state.continueRequestId + 1 }));
}

export function setWaitingContinue(waiting: boolean): void {
  playheadStore.setState({ waitingContinue: waiting });
}
