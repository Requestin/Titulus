import type { CrawlLayer, CrawlProps } from '@runtime';
import { Checkbox, Field, Input, NumberInput, Select } from '@/components/ui/form';

type UpdateLayer = (id: string, mutator: (layer: CrawlLayer) => void) => void;

export function CrawlProperties({
  layer,
  updateLayer,
}: {
  layer: CrawlLayer;
  updateLayer: UpdateLayer;
}) {
  function patch(partial: Partial<CrawlProps>) {
    updateLayer(layer.id, (item) => {
      if (item.type !== 'crawl') return;
      if (partial.type === 'carousel') {
        item.crawl = {
          ...item.crawl,
          ...partial,
          type: 'carousel',
          directionIn: partial.directionIn === 'up' || partial.directionIn === 'down'
            ? partial.directionIn
            : 'up',
          directionOut: partial.directionOut === 'up' || partial.directionOut === 'down'
            ? partial.directionOut
            : 'down',
        };
        return;
      }
      if (partial.type === 'ticker') {
        item.crawl = {
          ...item.crawl,
          ...partial,
          type: 'ticker',
          directionIn: partial.directionIn === 'left' || partial.directionIn === 'right'
            ? partial.directionIn
            : 'right',
          directionOut: partial.directionOut === 'left' || partial.directionOut === 'right'
            ? partial.directionOut
            : 'left',
        };
        return;
      }
      Object.assign(item.crawl, partial);
    });
  }

  const directions = layer.crawl.type === 'carousel'
    ? (['up', 'down'] as const)
    : (['left', 'right'] as const);

  return (
    <>
      <Field label="Type">
        <Select value={layer.crawl.type} onChange={(event) => patch({ type: event.target.value as CrawlProps['type'] })}>
          <option value="ticker">ticker</option>
          <option value="carousel">carousel</option>
        </Select>
      </Field>
      <Field label="In">
        <Select value={layer.crawl.directionIn} onChange={(event) => patch({ directionIn: event.target.value as never })}>
          {directions.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
        </Select>
      </Field>
      <Field label="Out">
        <Select value={layer.crawl.directionOut} onChange={(event) => patch({ directionOut: event.target.value as never })}>
          {directions.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
        </Select>
      </Field>
      <Field label="Speed">
        <NumberInput value={layer.crawl.speed} min={0.1} step={0.5} onChange={(value) => patch({ speed: Math.max(0.1, value) })} />
      </Field>
      <Field label="Pause">
        <NumberInput value={layer.crawl.pause} min={0} step={1} onChange={(value) => patch({ pause: Math.max(0, Math.round(value)) })} />
      </Field>
      <Field label="Anim">
        <Select value={layer.crawl.animationType} onChange={(event) => patch({ animationType: event.target.value as CrawlProps['animationType'] })}>
          <option value="batch">batch</option>
          <option value="continuous">continuous</option>
        </Select>
      </Field>
      <Field label="Separator">
        <Select value={layer.crawl.separatorMode} onChange={(event) => patch({ separatorMode: event.target.value as CrawlProps['separatorMode'] })}>
          <option value="none">none</option>
          <option value="text">text</option>
          <option value="image">image</option>
        </Select>
      </Field>
      {layer.crawl.separatorMode === 'text' && (
        <Field label="Separator text">
          <Input value={layer.crawl.separatorText} onChange={(event) => patch({ separatorText: event.target.value })} />
        </Field>
      )}
      <Checkbox
        label="Max length"
        checked={layer.crawl.maxTextLengthEnabled}
        onChange={(value) => patch({ maxTextLengthEnabled: value })}
      />
      {layer.crawl.maxTextLengthEnabled && (
        <Field label="Max chars">
          <NumberInput value={layer.crawl.maxTextLength} min={1} step={1} onChange={(value) => patch({ maxTextLength: Math.max(1, Math.round(value)) })} />
        </Field>
      )}
    </>
  );
}
