import type { OnAirDetailsSnapshot } from '@/core/api';

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
