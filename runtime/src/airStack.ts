export interface AirRootKey {
  layerId: number;
  takeSeq: number;
  slotId: string;
}

/** Lower LayerID is behind. Same LayerID keeps take order, then slotId. */
export function compareAirRoots(a: AirRootKey, b: AirRootKey): number {
  if (a.layerId !== b.layerId) return a.layerId - b.layerId;
  if (a.takeSeq !== b.takeSeq) return a.takeSeq - b.takeSeq;
  return a.slotId.localeCompare(b.slotId);
}

export function resolveLayerId(value: unknown, fallback = 50): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(99, Math.max(1, numeric));
}
