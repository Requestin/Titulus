import {
  scheduleCrawl,
  syncCrawlProgressKeys,
  type CrawlLayer,
  type CrawlProps,
  type Template,
  type VariableBinding,
} from '@runtime';
import { createId } from '@/core/id';

export function defaultCrawlProps(): CrawlProps {
  return {
    type: 'ticker',
    directionIn: 'right',
    directionOut: 'left',
    speed: 5,
    pause: 0,
    separatorMode: 'none',
    separatorText: '',
    separatorImage: '',
    animationType: 'batch',
    useFile: false,
    filePath: '',
    maxTextLengthEnabled: false,
    maxTextLength: 80,
  };
}

export function resolvedCrawlText(template: Template, layer: CrawlLayer): string {
  const content = layer.content;
  if (typeof content === 'string') return content;
  const variable = template.variables.find((item) => item.id === content.variableId);
  return String(variable?.defaultValue ?? '');
}

export function attachCrawlTimeline(template: Template, layer: CrawlLayer): void {
  const directorId = layer.crawlDirectorId || createId();
  layer.crawlDirectorId = directorId;
  const scheduled = scheduleCrawl({
    content: resolvedCrawlText(template, layer),
    fps: template.timeline.fps,
    box: { width: layer.transform.width, height: layer.transform.height },
    fontSize: layer.style.fontSize,
    align: layer.style.align,
    crawl: layer.crawl,
  });
  const durationFrames = Math.max(1, scheduled.durationFrames);
  const existing = template.timeline.directors.find((item) => item.id === directorId);
  if (existing) {
    existing.durationFrames = durationFrames;
    existing.loop = layer.crawl.animationType === 'continuous';
  } else {
    template.timeline.directors.push({
      id: directorId,
      name: 'Crawl',
      durationFrames,
      offsetFrames: 0,
      autostart: true,
      loop: layer.crawl.animationType === 'continuous',
      swing: false,
    });
  }
  template.timeline.trackDirectors[layer.id] = directorId;
  template.timeline.propertyTrackDirectors = {
    ...template.timeline.propertyTrackDirectors,
    [layer.id]: {
      ...template.timeline.propertyTrackDirectors?.[layer.id],
      crawlProgress: directorId,
    },
  };
  syncCrawlProgressKeys(template.timeline.keyframes, layer.id, durationFrames, createId);
}

export function attachAllCrawlTimelines(template: Template): void {
  for (const layer of template.layers) {
    if (layer.type === 'crawl') attachCrawlTimeline(template, layer);
  }
}

export function isCrawlDirector(template: Template, directorId: string): boolean {
  return template.layers.some((layer) => layer.type === 'crawl' && layer.crawlDirectorId === directorId);
}

export function isCrawlContentBinding(value: string | VariableBinding): value is VariableBinding {
  return typeof value === 'object' && value !== null && value.type === 'variable';
}
