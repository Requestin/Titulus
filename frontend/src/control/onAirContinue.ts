import type { OnAirDetailsItem, OnAirDetailsSnapshot } from '@/core/api';

export function isWaitingContinue(
  details: OnAirDetailsSnapshot | null | undefined,
  channelId: string,
  templateId: string,
): boolean {
  return details?.channels[channelId]?.some(
    (item) => item.templateId === templateId && item.waitingContinue,
  ) ?? false;
}

export function continueCommand(channelId: string, templateId: string) {
  return { type: 'continue' as const, channelId, templateId };
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
