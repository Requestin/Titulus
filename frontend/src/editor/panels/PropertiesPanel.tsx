// frontend/src/editor/panels/PropertiesPanel.tsx
//
// Inspector for the current selection: base props, transform, type-specific
// style, and variable bindings on string fields (content / fill / src).

import { useState } from 'react';
import { Braces, Link2, Unlink } from 'lucide-react';
import type { Layer, Template, Variable, VariableBinding, BlendMode, TextTransformMode } from '@runtime';
import { useEditor } from '../store';
import { effectiveOpacity, effectiveTransform } from '../effectiveValues';
import {
  axisCenterFromPixels,
  axisCenterFromPixelsGroup,
  axisCenterPresetX,
  axisCenterPresetXGroup,
  axisCenterPresetY,
  axisCenterPresetYGroup,
  computeGroupBbox,
} from '../groupBounds';
import { MediaSourcePicker } from '../media/MediaSourcePicker';
import { CrawlTypeSections } from '../CrawlProperties';
import { PropertyField, Section, Input, NumberInput, Select, ColorInput, Checkbox } from '@/components/ui/form';
import type { NumberInputExtraAction } from '@/components/ui/form';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten'];

export function PropertiesPanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const updateLayer = useEditor((s) => s.updateLayer);
  const setLayerOpacity = useEditor((s) => s.setLayerOpacity);
  const updateTransform = useEditor((s) => s.updateTransform);
  const playheads = useEditor((s) => s.playheads);
  const setLayerGroup = useEditor((s) => s.setLayerGroup);
  const patch = useEditor((s) => s.patch);

  if (!template || !selection) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[13px] text-ink-faint">
        Select a layer to edit its properties.
      </div>
    );
  }

  const variables = template.variables;

  if (selection.kind === 'group') {
    const g = template.groups.find((x) => x.id === selection.id);
    if (!g) return null;
    return (
      <div className="overflow-auto">
        <Section title="Group">
          <PropertyField label="Name">
            <Input value={g.name} onChange={(e) => patch((t) => { const x = t.groups.find((q) => q.id === g.id); if (x) x.name = e.target.value; })} />
          </PropertyField>
        </Section>
        <SizeSection
          id={g.id}
          kind="group"
          canvas={template.canvas}
          t={effectiveTransform(template, g.transform, { kind: 'group', id: g.id }, playheads)}
          updateTransform={updateTransform}
        />
        <PositionSection
          id={g.id}
          kind="group"
          template={template}
          t={effectiveTransform(template, g.transform, { kind: 'group', id: g.id }, playheads)}
          updateTransform={updateTransform}
        />
      </div>
    );
  }

  const layer = template.layers.find((l) => l.id === selection.id);
  if (!layer) return null;

  return (
    <div className="overflow-auto">
      <Section title="Layer">
        <PropertyField label="Name">
          <Input value={layer.name} onChange={(e) => updateLayer(layer.id, (l) => { l.name = e.target.value; })} />
        </PropertyField>
        {layer.type !== 'mask' && (
          <>
            <PropertyField label="Opacity">
              <NumberInput
                value={effectiveOpacity(template, layer.opacity, { kind: 'layer', id: layer.id }, playheads)}
                min={0}
                max={1}
                step={0.05}
                resetValue={1}
                onChange={(v) => setLayerOpacity(layer.id, v)}
              />
            </PropertyField>
            <PropertyField label="Blend">
              <Select value={layer.blendMode} onChange={(e) => updateLayer(layer.id, (l) => { l.blendMode = e.target.value as BlendMode; })}>
                {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </PropertyField>
          </>
        )}
        <PropertyField label="Group">
          <Select
            value={layer.groupId ?? ''}
            onChange={(e) => setLayerGroup(layer.id, e.target.value || null)}
          >
            <option value="">(none)</option>
            {template.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </PropertyField>
      </Section>

      <SizeSection
        id={layer.id}
        kind="layer"
        canvas={template.canvas}
        t={effectiveTransform(template, layer.transform, { kind: 'layer', id: layer.id }, playheads)}
        updateTransform={updateTransform}
      />
      <PositionSection
        id={layer.id}
        kind="layer"
        template={template}
        t={effectiveTransform(template, layer.transform, { kind: 'layer', id: layer.id }, playheads)}
        updateTransform={updateTransform}
      />

      <TypeSection layer={layer} variables={variables} updateLayer={updateLayer} />
    </div>
  );
}

function SizeSection({
  id, kind, canvas, t, updateTransform,
}: {
  id: string;
  kind: 'layer' | 'group';
  canvas: Template['canvas'];
  t: Layer['transform'];
  updateTransform: (id: string, partial: Partial<Layer['transform']>, kind?: 'layer' | 'group') => void;
}) {
  const [scaleLocked, setScaleLocked] = useState(true);
  const set = (partial: Partial<Layer['transform']>) => updateTransform(id, partial, kind);

  function setScaleX(v: number) {
    if (scaleLocked) set({ scaleX: v, scaleY: v });
    else set({ scaleX: v });
  }
  function setScaleY(v: number) {
    if (scaleLocked) set({ scaleX: v, scaleY: v });
    else set({ scaleY: v });
  }

  return (
    <Section title="Size">
      {kind === 'layer' && (
        <>
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="neutral"
              title={`Set size to canvas ${canvas.width}×${canvas.height}`}
              onClick={() => set({ width: canvas.width, height: canvas.height })}
            >
              Screen
            </Button>
            <Button
              size="sm"
              variant="neutral"
              title={`Set height to canvas height (${canvas.height})`}
              onClick={() => set({ height: canvas.height })}
            >
              Height
            </Button>
            <Button
              size="sm"
              variant="neutral"
              title={`Set width to canvas width (${canvas.width})`}
              onClick={() => set({ width: canvas.width })}
            >
              Width
            </Button>
          </div>
          <LabeledNum label="Width" value={t.width} resetValue={300} onChange={(v) => set({ width: v })} />
          <LabeledNum label="Height" value={t.height} resetValue={80} onChange={(v) => set({ height: v })} />
        </>
      )}
      <div className="grid grid-cols-[68px_minmax(0,1fr)] grid-rows-[2rem_3px_2rem] gap-x-2">
        <label className="row-start-1 flex items-center truncate text-[12px] leading-none text-ink-muted">
          Scale X
        </label>
        <div className="row-start-1 min-w-0 -ml-5 w-[calc(100%+20px)]">
          <NumberInput value={t.scaleX} step={0.05} resetValue={1} onChange={setScaleX} />
        </div>
        <button
          type="button"
          title={scaleLocked ? 'Unlink scale X/Y' : 'Link scale X/Y'}
          aria-pressed={scaleLocked}
          onClick={() => setScaleLocked((v) => !v)}
          className={cn(
            'row-start-2 flex items-center justify-start self-center overflow-visible',
            scaleLocked ? 'text-primary' : 'text-ink-faint hover:text-ink',
          )}
        >
          {scaleLocked
            ? <Link2 className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
            : <Unlink className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />}
        </button>
        <label className="row-start-3 flex items-center truncate text-[12px] leading-none text-ink-muted">
          Scale Y
        </label>
        <div className="row-start-3 min-w-0 -ml-5 w-[calc(100%+20px)]">
          <NumberInput value={t.scaleY} step={0.05} resetValue={1} onChange={setScaleY} />
        </div>
      </div>
    </Section>
  );
}

function PositionSection({
  id, kind, template, t, updateTransform,
}: {
  id: string;
  kind: 'layer' | 'group';
  template: Template;
  t: Layer['transform'];
  updateTransform: (id: string, partial: Partial<Layer['transform']>, kind?: 'layer' | 'group') => void;
}) {
  const set = (partial: Partial<Layer['transform']>) => updateTransform(id, partial, kind);
  const groupBbox = kind === 'group' ? computeGroupBbox(template, id) : null;
  const axisPxX = groupBbox ? groupBbox.width * t.anchorX : t.width * t.anchorX;
  const axisPxY = groupBbox ? groupBbox.height * t.anchorY : t.height * t.anchorY;
  const groupAxisReady = kind !== 'group' || groupBbox !== null;

  return (
    <Section title="Position">
      <LabeledNum label="X" value={t.x} resetValue={0} onChange={(v) => set({ x: v })} />
      <LabeledNum label="Y" value={t.y} resetValue={0} onChange={(v) => set({ y: v })} />

      <div className="pt-1">
        <h4 className="mb-2 text-[11px] font-semibold text-ink-faint">Rotation</h4>
        <div className="space-y-2">
          <LabeledNum
            label="X"
            value={t.rotationX}
            resetValue={0}
            onChange={(v) => set({ rotationX: v })}
            extraActions={[
              { label: '+45', onClick: () => set({ rotationX: t.rotationX + 45 }) },
              { label: '-45', onClick: () => set({ rotationX: t.rotationX - 45 }) },
            ]}
          />
          <LabeledNum
            label="Y"
            value={t.rotationY}
            resetValue={0}
            onChange={(v) => set({ rotationY: v })}
            extraActions={[
              { label: '+45', onClick: () => set({ rotationY: t.rotationY + 45 }) },
              { label: '-45', onClick: () => set({ rotationY: t.rotationY - 45 }) },
            ]}
          />
          <LabeledNum
            label="Z"
            value={t.rotation}
            resetValue={0}
            onChange={(v) => set({ rotation: v })}
            extraActions={[
              { label: '+45', onClick: () => set({ rotation: t.rotation + 45 }) },
              { label: '-45', onClick: () => set({ rotation: t.rotation - 45 }) },
            ]}
          />
          <LabeledNum label="Perspective" value={t.perspective} resetValue={1000} onChange={(v) => set({ perspective: v })} />
        </div>
      </div>

      <div className="pt-1">
        <h4 className="mb-2 text-[11px] font-semibold text-ink-faint">Axis center</h4>
        <div className="space-y-2">
          <AxisCenterRow
            label="X"
            value={axisPxX}
            resetValue={0}
            presets={['L', 'C', 'R']}
            onChange={(v) => {
              if (!groupAxisReady) return;
              set(
                kind === 'group' && groupBbox
                  ? axisCenterFromPixelsGroup(t, groupBbox, 'x', v)
                  : axisCenterFromPixels(t, 'x', v),
              );
            }}
            onPreset={(p) => {
              if (!groupAxisReady) return;
              set(
                kind === 'group' && groupBbox
                  ? axisCenterPresetXGroup(t, groupBbox, p)
                  : axisCenterPresetX(t, p),
              );
            }}
          />
          <AxisCenterRow
            label="Y"
            value={axisPxY}
            resetValue={0}
            presets={['B', 'C', 'T']}
            onChange={(v) => {
              if (!groupAxisReady) return;
              set(
                kind === 'group' && groupBbox
                  ? axisCenterFromPixelsGroup(t, groupBbox, 'y', v)
                  : axisCenterFromPixels(t, 'y', v),
              );
            }}
            onPreset={(p) => {
              if (!groupAxisReady) return;
              set(
                kind === 'group' && groupBbox
                  ? axisCenterPresetYGroup(t, groupBbox, p)
                  : axisCenterPresetY(t, p),
              );
            }}
          />
        </div>
      </div>
    </Section>
  );
}

function AxisCenterRow<P extends string>({
  label,
  value,
  resetValue,
  presets,
  onChange,
  onPreset,
}: {
  label: 'X' | 'Y';
  value: number;
  resetValue: number;
  presets: readonly P[];
  onChange: (v: number) => void;
  onPreset: (p: P) => void;
}) {
  return (
    <PropertyField label={label}>
      <div className="flex min-w-0 items-center gap-1">
        <NumberInput
          value={value}
          step={1}
          resetValue={resetValue}
          onChange={onChange}
          className="min-w-0 flex-1"
        />
        <div className="flex shrink-0 gap-0.5">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              title={p}
              onClick={() => onPreset(p)}
              className="grid h-8 w-6 place-items-center rounded-md border border-border bg-surface-2 text-[10px] font-semibold text-ink-muted hover:border-ink-faint hover:text-ink"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </PropertyField>
  );
}

function LabeledNum({
  label,
  value,
  onChange,
  step,
  resetValue,
  extraActions,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  resetValue?: number;
  extraActions?: NumberInputExtraAction[];
  disabled?: boolean;
}) {
  return (
    <PropertyField label={label}>
      <NumberInput
        value={value}
        step={step}
        resetValue={resetValue}
        extraActions={extraActions}
        onChange={onChange}
        disabled={disabled}
      />
    </PropertyField>
  );
}

type UpdateLayer = (id: string, mutator: (l: Layer) => void) => void;

function TypeSection({ layer, variables, updateLayer }: { layer: Layer; variables: Variable[]; updateLayer: UpdateLayer }) {
  switch (layer.type) {
    case 'text':
      return (
        <>
          <Section title="Content">
            <BindableField
              kind="text"
              value={layer.content}
              variables={variables}
              onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'text') l.content = v; })}
            />
          </Section>
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} />
        </>
      );
    case 'rect':
      return (
        <Section title="Rectangle">
          <PropertyField label="Fill">
            <BindableField
              kind="color"
              value={layer.fill}
              variables={variables}
              onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.fill = v; })}
            />
          </PropertyField>
          <PropertyField label="Radius">
            <NumberInput value={layer.cornerRadius} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.cornerRadius = v; })} />
          </PropertyField>
          <PropertyField label="Border">
            <NumberInput value={layer.borderWidth} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.borderWidth = v; })} />
          </PropertyField>
          <PropertyField label="Border color">
            <ColorInput value={layer.borderColor} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.borderColor = v; })} />
          </PropertyField>
        </Section>
      );
    case 'mask':
      return (
        <Section title="Mask">
          <PropertyField label="Mode">
            <Select value={layer.maskMode} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.maskMode = e.target.value as 'normal' | 'inverted'; })}>
              <option value="normal">normal</option>
              <option value="inverted">inverted</option>
            </Select>
          </PropertyField>
          <PropertyField label="Shape">
            <Select value={layer.shape} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.shape = e.target.value as 'rect' | 'ellipse'; })}>
              <option value="rect">rect</option>
              <option value="ellipse">ellipse</option>
            </Select>
          </PropertyField>
          <PropertyField label="Radius">
            <NumberInput value={layer.cornerRadius} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.cornerRadius = v; })} />
          </PropertyField>
        </Section>
      );
    case 'image':
    case 'video':
      return (
        <Section title={layer.type === 'image' ? 'Image' : 'Video'}>
          <MediaSourcePicker
            type={layer.type}
            src={typeof layer.src === 'string' ? layer.src : ''}
            onSelect={(url) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.src = url; })}
          />
          <PropertyField label="Fit">
            <Select value={layer.fit} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.fit = e.target.value as 'stretch' | 'contain' | 'cover'; })}>
              <option value="cover">cover</option>
              <option value="contain">contain</option>
              <option value="stretch">stretch</option>
            </Select>
          </PropertyField>
          {layer.type === 'image' && (
            <PropertyField label="Radius">
              <NumberInput value={layer.cornerRadius} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'image') l.cornerRadius = v; })} />
            </PropertyField>
          )}
          {layer.type === 'video' && (
            <Checkbox label="Loop" checked={layer.loop} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'video') l.loop = v; })} />
          )}
        </Section>
      );
    case 'clock':
      return (
        <>
          <Section title="Clock">
            <PropertyField label="Mode">
              <Select value={layer.mode} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'clock') l.mode = e.target.value as 'clock' | 'countup' | 'countdown'; })}>
                <option value="clock">clock</option>
                <option value="countup">countup</option>
                <option value="countdown">countdown</option>
              </Select>
            </PropertyField>
            <PropertyField label="Format">
              <Input value={layer.format} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'clock') l.format = e.target.value; })} />
            </PropertyField>
            {layer.mode === 'countup' && (
              <PropertyField label="Start time">
                <Input
                  type="datetime-local"
                  step={1}
                  value={epochToDatetimeLocal(layer.startTime)}
                  onChange={(e) =>
                    updateLayer(layer.id, (l) => {
                      if (l.type !== 'clock') return;
                      const ms = datetimeLocalToEpoch(e.target.value);
                      if (ms === undefined) delete l.startTime;
                      else l.startTime = ms;
                    })
                  }
                />
              </PropertyField>
            )}
            {layer.mode === 'countdown' && (
              <PropertyField label="Target time">
                <Input
                  type="datetime-local"
                  step={1}
                  value={epochToDatetimeLocal(layer.targetTime)}
                  onChange={(e) =>
                    updateLayer(layer.id, (l) => {
                      if (l.type !== 'clock') return;
                      const ms = datetimeLocalToEpoch(e.target.value);
                      if (ms === undefined) delete l.targetTime;
                      else l.targetTime = ms;
                    })
                  }
                />
              </PropertyField>
            )}
          </Section>
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} />
        </>
      );
    case 'crawl':
      return (
        <>
          <CrawlTypeSections layer={layer} variables={variables} updateLayer={updateLayer} />
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} />
        </>
      );
  }
}

function TextStyleSection({ layer, variables, updateLayer }: { layer: Extract<Layer, { style: import('@runtime').TextStyle }>; variables: Variable[]; updateLayer: UpdateLayer }) {
  const s = layer.style;
  const setStyle = (mutator: (st: import('@runtime').TextStyle) => void) =>
    updateLayer(layer.id, (l) => { if ('style' in l) mutator(l.style); });
  const shadowOn = s.dropShadow;
  const transform = s.textTransform ?? 'none';
  const shadowX = typeof s.dropShadowOffsetX === 'number' ? s.dropShadowOffsetX : 1;
  const shadowY = typeof s.dropShadowOffsetY === 'number' ? s.dropShadowOffsetY : 1;
  return (
    <Section title="Text style">
      <PropertyField label="Font">
        <Input value={s.fontFamily} onChange={(e) => setStyle((st) => { st.fontFamily = e.target.value; })} />
      </PropertyField>
      <LabeledNum label="Size" value={s.fontSize} resetValue={48} onChange={(v) => setStyle((st) => { st.fontSize = v; })} />
      <PropertyField label="Weight">
        <Select value={s.fontWeight} onChange={(e) => setStyle((st) => { st.fontWeight = e.target.value; })}>
          {['300', '400', '500', '600', '700', '800', '900'].map((w) => <option key={w} value={w}>{w}</option>)}
        </Select>
      </PropertyField>
      <PropertyField label="Color">
        <BindableField kind="color" value={s.fill} variables={variables} onChange={(v) => setStyle((st) => { st.fill = v; })} />
      </PropertyField>
      {(layer.type === 'text' || layer.type === 'crawl') && (
        <div className="space-y-1.5">
          <div className="text-[12px] text-ink-muted">Text transformation</div>
          <div className="flex gap-1" role="radiogroup" aria-label="Text transformation">
            {(
              [
                { mode: 'none', label: 'X', title: 'As written' },
                { mode: 'uppercase', label: 'AA', title: 'Uppercase' },
                { mode: 'titlecase', label: 'Aa', title: 'Title case' },
                { mode: 'lowercase', label: 'aa', title: 'Lowercase' },
              ] as const
            ).map((opt) => {
              const active = transform === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  title={opt.title}
                  onClick={() => setStyle((st) => { st.textTransform = opt.mode as TextTransformMode; })}
                  className={cn(
                    'h-8 min-w-0 flex-1 rounded-md border text-[12px] font-semibold tabular-nums transition-colors',
                    active
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border bg-surface-2 text-ink-muted hover:text-ink',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <PropertyField label="Align">
        <Select value={s.align} onChange={(e) => setStyle((st) => { st.align = e.target.value as 'left' | 'center' | 'right'; })}>
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </Select>
      </PropertyField>
      <LabeledNum label="Line height" value={s.lineHeight} resetValue={1.1} step={0.05} onChange={(v) => setStyle((st) => { st.lineHeight = v; })} />
      <LabeledNum label="Spacing" value={s.letterSpacing} resetValue={0} onChange={(v) => setStyle((st) => { st.letterSpacing = v; })} />
      <Checkbox label="Drop shadow" checked={shadowOn} onChange={(v) => setStyle((st) => { st.dropShadow = v; })} />
      <div className={cn('space-y-2', !shadowOn && 'opacity-40')}>
        <PropertyField label="Color">
          <ColorInput
            value={s.dropShadowColor || '#000000'}
            disabled={!shadowOn}
            onChange={(c) => setStyle((st) => { st.dropShadowColor = c; })}
          />
        </PropertyField>
        <LabeledNum
          label="X"
          value={shadowX}
          resetValue={1}
          disabled={!shadowOn}
          onChange={(v) => setStyle((st) => { st.dropShadowOffsetX = v; delete st.dropShadowDistance; })}
        />
        <LabeledNum
          label="Y"
          value={shadowY}
          resetValue={1}
          disabled={!shadowOn}
          onChange={(v) => setStyle((st) => { st.dropShadowOffsetY = v; delete st.dropShadowDistance; })}
        />
        <LabeledNum
          label="Blur"
          value={s.dropShadowBlur}
          resetValue={0}
          disabled={!shadowOn}
          onChange={(v) => setStyle((st) => { st.dropShadowBlur = v; })}
        />
      </div>
    </Section>
  );
}

function BindableField({
  value, onChange, kind, variables,
}: {
  value: string | VariableBinding;
  onChange: (v: string | VariableBinding) => void;
  kind: 'text' | 'color';
  variables: Variable[];
}) {
  const isBound = typeof value === 'object' && value !== null;
  return (
    <div className="flex items-center gap-1.5">
      {isBound ? (
        <Select
          className="flex-1"
          value={value.variableId}
          onChange={(e) => onChange({ type: 'variable', variableId: e.target.value })}
        >
          {variables.length === 0 && <option value="">No variables</option>}
          {variables.map((v) => <option key={v.id} value={v.id}>{v.label || v.name}</option>)}
        </Select>
      ) : (
        <div className="min-w-0 flex-1">
          {kind === 'color'
            ? <ColorInput value={value} onChange={(c) => onChange(c)} />
            : <Input value={value} onChange={(e) => onChange(e.target.value)} />}
        </div>
      )}
      <button
        title={isBound ? 'Unbind variable' : 'Bind to variable'}
        disabled={!isBound && variables.length === 0}
        onClick={() => {
          if (isBound) onChange('');
          else if (variables[0]) onChange({ type: 'variable', variableId: variables[0].id });
        }}
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border',
          isBound ? 'border-primary text-primary' : 'text-ink-faint hover:text-ink disabled:opacity-40',
        )}
      >
        <Braces className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

function epochToDatetimeLocal(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function datetimeLocalToEpoch(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}
