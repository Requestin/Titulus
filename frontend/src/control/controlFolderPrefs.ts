import {
  readBooleanPreference,
  writeBooleanPreference,
  type StorageLike,
} from '@/ui/chromePrefs';

export const HIDE_ALL_IN_CONTROL_KEY = 'titulus.folders.hideAllInControl';
export const HIDE_UNASSIGNED_IN_CONTROL_KEY = 'titulus.folders.hideUnassignedInControl';

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readHideAllInControl(storage?: StorageLike | null): boolean {
  const store = storage ?? safeStorage();
  return store ? readBooleanPreference(store, HIDE_ALL_IN_CONTROL_KEY, false) : false;
}

export function writeHideAllInControl(value: boolean, storage?: StorageLike | null): void {
  const store = storage ?? safeStorage();
  if (store) writeBooleanPreference(store, HIDE_ALL_IN_CONTROL_KEY, value);
}

export function readHideUnassignedInControl(storage?: StorageLike | null): boolean {
  const store = storage ?? safeStorage();
  return store ? readBooleanPreference(store, HIDE_UNASSIGNED_IN_CONTROL_KEY, false) : false;
}

export function writeHideUnassignedInControl(value: boolean, storage?: StorageLike | null): void {
  const store = storage ?? safeStorage();
  if (store) writeBooleanPreference(store, HIDE_UNASSIGNED_IN_CONTROL_KEY, value);
}

export function lastRundownStorageKey(channelId: string): string {
  return `titulus.control.lastRundown.${channelId}`;
}

export function readLastRundownId(channelId: string, storage?: StorageLike | null): string | null {
  const store = storage ?? safeStorage();
  if (!store || !channelId) return null;
  try {
    const value = store.getItem(lastRundownStorageKey(channelId));
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function writeLastRundownId(
  channelId: string,
  rundownId: string,
  storage?: StorageLike | null,
): void {
  const store = storage ?? safeStorage();
  if (!store || !channelId || !rundownId) return;
  try {
    store.setItem(lastRundownStorageKey(channelId), rundownId);
  } catch {
    // Preferences are best-effort.
  }
}
