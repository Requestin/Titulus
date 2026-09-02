import type { OnAirDetailsItem, OnAirDetailsSnapshot } from '@/core/api';
import { resolveLayerId } from '@runtime';

export function isWaitingContinue(
  details: OnAirDetailsSnapshot | null | undefined,
  channelId: string,
  templateId: string,
): boolean {
  return details?.channels[channelId]?.some(
    (item) => (
      (item.templateId === templateId || item.slotId === templateId)
      && item.waitingContinue
    ),
  ) ?? false;
}

export function continueCommand(channelId: string, templateId: string) {
  return { type: 'continue' as const, channelId, templateId };
}

/** Slot ids currently shown as live. Prefers details.slotId after Update ownership transfer. */
export function liveSlotIdSet(
  details: OnAirDetailsSnapshot | null | undefined,
  channelId: string,
  fallbackIds: string[],
): Set<string> {
  const items = details?.channels[channelId];
  if (items && items.length > 0) {
    return new Set(items.map((item) => item.slotId || item.templateId));
  }
  return new Set(fallbackIds);
}

/** Renderer identity for continue/clear. Stays on the first take id when Update transfers the slot. */
export function runtimeIdForSlot(
  details: OnAirDetailsSnapshot | null | undefined,
  channelId: string,
  slotId: string,
): string {
  const items = details?.channels[channelId] ?? [];
  const bySlot = items.find((item) => item.slotId === slotId);
  if (bySlot) return bySlot.templateId;
  const byRuntime = items.find((item) => item.templateId === slotId);
  return byRuntime?.templateId ?? slotId;
}

export function occupantForSourceLayer(
  details: OnAirDetailsSnapshot | null | undefined,
  channelId: string,
  sourceTemplateId: string,
  layerId: number,
): OnAirDetailsItem | undefined {
  const want = resolveLayerId(layerId);
  return details?.channels[channelId]?.find((item) => (
    item.sourceTemplateId === sourceTemplateId
    && resolveLayerId(item.layerId) === want
  ));
}

export function resolveOnAirRows(
  details: OnAirDetailsSnapshot | null | undefined,
  channelId: string,
  fallbackIds: string[],
): OnAirDetailsItem[] {
  const items = details?.channels[channelId];
  if (items && items.length > 0) {
    return [...items].sort((a, b) => {
      const layer = (a.layerId ?? 50) - (b.layerId ?? 50);
      if (layer !== 0) return layer;
      return a.templateId.localeCompare(b.templateId);
    });
  }
  return fallbackIds.map((templateId) => ({ templateId, waitingContinue: false }));
}

/** Slot take: on-air id is the slot, sourceTemplateId is the catalog/authored template. */
export function onAirOwnerLabel(item: OnAirDetailsItem): string {
  if (item.slotId && item.sourceTemplateId && item.slotId !== item.sourceTemplateId) {
    return `slot ${item.slotId}`;
  }
  return 'template';
}

export function formatOnAirRow(item: OnAirDetailsItem, name: string, owner = onAirOwnerLabel(item)): string {
  return `L${item.layerId ?? 50} · ${name} · ${owner}`;
}
