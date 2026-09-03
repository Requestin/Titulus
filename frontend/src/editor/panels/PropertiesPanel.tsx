// frontend/src/editor/panels/PropertiesPanel.tsx
//
// Inspector for the current selection: base props, transform, type-specific
// style, and variable bindings on string fields (content / fill / src).

import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Braces, Link2, Link2Off } from 'lucide-react';
import type { AnimatableProp, Layer, Variable, VariableBinding, BlendMode } from '@runtime';
import { anchorCompensatedUpdate } from '@runtime';
import { useEditor } from '../store';
import { CrawlProperties } from '../CrawlProperties';
import { CueInspector } from '../timeline/CueInspector';
import { effectiveGradientWeight, effectiveOpacity, effectiveTransform } from '../effectiveValues';
import { usePlayhead } from '../playheadStore';
import { clearGesturePreview, gesturePreviewStore, scheduleGesturePreview } from '../gesturePreview';
import { MediaUploadButton } from '../MediaUploadButton';
import { MamPicker, SelectedMediaInfo } from '@/media/MamPicker';
import { FontFamilySelect, FontMamDialog } from '@/media/FontMamDialog';
import {
  Checkbox,
  CollapseAllButton,
  ColorInput,
  Field,
  Input,
  NumberInput,
  Section,
  SectionCollapseProvider,
  Select,
  type SectionCollapseSignal,
} from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { LAYER_DEFAULT_DIMENSIONS } from '../factories';
import { DefaultNameInput } from '../DefaultNameInput';
import { useStore } from 'zustand';
import { nudgeAngle45 } from '@/ui/numberInputMath';
import { boxInParentSpace, derivedGroupBox } from '../groupBounds';
import { ancestorMatrix } from '../transformMath';
import {
  axisPresetX,
  axisPresetXForBox,
  axisPresetY,
  axisPresetYForBox,
  anchorCompensatedUpdateForBox,
  canvasFitSize,
  has25dCost,
  lockedScale,
  type AxisPreset,
} from '../axisPresets';

const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten'];

export function PropertiesPanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const updateLayer = useEditor((s) => s.updateLayer);
  const setLayerOpacity = useEditor((s) => s.setLayerOpacity);
  const setGradientWeight = useEditor((s) => s.setGradientWeight);
  const updateTransform = useEditor((s) => s.updateTransform);
  const updateGroupPivot = useEditor((s) => s.updateGroupPivot);
  const playhead = usePlayhead((s) => s.playhead);
  const activeDirectorId = useEditor((s) => s.activeDirectorId);
  const setLayerGroup = useEditor((s) => s.setLayerGroup);
  const patch = useEditor((s) => s.patch);
  const gesturePreview = useStore(gesturePreviewStore, (s) => s.preview);
  const [collapseSignal, setCollapseSignal] = useState<SectionCollapseSignal>({
    version: 0,
    open: true,
  });
  const [fontMamOpen, setFontMamOpen] = useState(false);
  const selectedCueId = useEditor((s) => s.selectedCueId);
  const updateCue = useEditor((s) => s.updateCue);
  const updateCueItem = useEditor((s) => s.updateCueItem);
  const addCueItem = useEditor((s) => s.addCueItem);
  const removeCueItem = useEditor((s) => s.removeCueItem);

  if (template && selectedCueId) {
    const cue = (template.timeline.cues ?? []).find((item) => item.id === selectedCueId);
    if (cue) {
      return (
        <div className="flex h-full flex-col">
          <PropertiesToolbar signal={collapseSignal} onChange={setCollapseSignal} />
          <div className="min-h-0 flex-1 overflow-auto">
            <CueInspector
              cue={cue}
              directors={template.timeline.directors}
              onUpdateCue={(partial) => updateCue(cue.id, partial)}
              onUpdateItem={(itemId, item) => updateCueItem(cue.id, itemId, item)}
              onAddItem={() => addCueItem(cue.id)}
              onRemoveItem={(itemId) => removeCueItem(cue.id, itemId)}
            />
          </div>
        </div>
      );
    }
  }

  if (!template) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[13px] text-ink-faint">
        Open a template to edit its properties.
      </div>
    );
  }

  if (!selection) {
    return (
      <div className="flex h-full flex-col">
        <PropertiesToolbar signal={collapseSignal} onChange={setCollapseSignal} />
        <div className="min-h-0 flex-1 overflow-auto">
          <SectionCollapseProvider signal={collapseSignal}>
            <Section title="Template">
              <Field label="LayerID">
                <NumberInput
                  value={template.layerId ?? 50}
                  min={1}
                  max={99}
                  step={1}
                  onChange={(value) => patch((t) => {
                    t.layerId = Math.min(99, Math.max(1, Math.round(value)));
                  })}
                />
              </Field>
              <Field label="Default DE name">
                <DefaultNameInput
                  value={template.defaultNameForDataElements ?? ''}
                  variables={template.variables}
                  onChange={(next) => patch((t) => {
                    const trimmed = next.trim();
                    if (trimmed) t.defaultNameForDataElements = next;
                    else delete t.defaultNameForDataElements;
                  })}
                />
              </Field>
            </Section>
          </SectionCollapseProvider>
        </div>
      </div>
    );
  }

  const variables = template.variables;

  if (selection.kind === 'group') {
    const g = template.groups.find((x) => x.id === selection.id);
    if (!g) return null;
    return (
      <div className="flex h-full flex-col">
        <PropertiesToolbar signal={collapseSignal} onChange={setCollapseSignal} />
        <div className="min-h-0 flex-1 overflow-auto">
          <SectionCollapseProvider signal={collapseSignal}>
            <Section title="Group">
              <Field label="Name">
                <Input value={g.name} onChange={(e) => patch((t) => { const x = t.groups.find((q) => q.id === g.id); if (x) x.name = e.target.value; })} />
              </Field>
            </Section>
            <TransformSection
              id={g.id}
              kind="group"
              t={gesturePreview?.id === g.id && gesturePreview.kind === 'group'
                ? gesturePreview.transform
                : effectiveTransform(template, g.transform, { kind: 'group', id: g.id }, playhead, activeDirectorId)}
              canvas={template.canvas}
              visualBox={(() => {
                const canvasBox = derivedGroupBox(
                  template,
                  g.id,
                  (id) => {
                    const layer = template.layers.find((item) => item.id === id);
                    return layer
                      ? effectiveTransform(template, layer.transform, { kind: 'layer', id }, playhead, activeDirectorId)
                      : g.transform;
                  },
                  (id) => {
                    const group = template.groups.find((item) => item.id === id);
                    return group
                      ? effectiveTransform(template, group.transform, { kind: 'group', id }, playhead, activeDirectorId)
                      : g.transform;
                  },
                );
                if (!canvasBox) return null;
                return boxInParentSpace(
                  canvasBox,
                  ancestorMatrix(template, g.parentId, (group) => (
                    effectiveTransform(template, group.transform, { kind: 'group', id: group.id }, playhead, activeDirectorId)
                  )),
                );
              })()}
              updateTransform={updateTransform}
              updateGroupPivot={updateGroupPivot}
            />
          </SectionCollapseProvider>
        </div>
      </div>
    );
  }

  const layer = template.layers.find((l) => l.id === selection.id);
  if (!layer) return null;

  return (
    <div className="flex h-full flex-col">
      <PropertiesToolbar signal={collapseSignal} onChange={setCollapseSignal} />
      <div className="min-h-0 flex-1 overflow-auto">
        <SectionCollapseProvider signal={collapseSignal}>
          <Section title="Layer">
            <Field label="Name">
              <Input value={layer.name} onChange={(e) => updateLayer(layer.id, (l) => { l.name = e.target.value; })} />
            </Field>
            {layer.type !== 'mask' && (
              <>
                <LabeledNum
                  label="Opacity"
                  value={effectiveOpacity(template, layer.opacity, { kind: 'layer', id: layer.id }, playhead, activeDirectorId)}
                  min={0}
                  max={1}
                  step={0.05}
                  resetValue={1}
                  onChange={(v) => setLayerOpacity(layer.id, v)}
                />
                <Field label="Blend">
                  <Select value={layer.blendMode} onChange={(e) => updateLayer(layer.id, (l) => { l.blendMode = e.target.value as BlendMode; })}>
                    {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </Field>
              </>
            )}
            <Field label="Group">
              <Select
                value={layer.groupId ?? ''}
                onChange={(e) => setLayerGroup(layer.id, e.target.value || null)}
              >
                <option value="">(none)</option>
                {template.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </Field>
          </Section>

          <TransformSection
            id={layer.id}
            kind="layer"
            t={gesturePreview?.id === layer.id && gesturePreview.kind === 'layer'
              ? gesturePreview.transform
              : effectiveTransform(template, layer.transform, { kind: 'layer', id: layer.id }, playhead, activeDirectorId)}
            layerType={layer.type}
            canvas={template.canvas}
            updateTransform={updateTransform}
          />

          <TypeSection
            layer={layer}
            variables={variables}
            updateLayer={updateLayer}
            setGradientWeight={setGradientWeight}
            onOpenFontMam={() => setFontMamOpen(true)}
            weightValue={(prop, base) => effectiveGradientWeight(
              template,
              base,
              { kind: 'layer', id: layer.id },
              prop,
              playhead,
              activeDirectorId,
            )}
          />
        </SectionCollapseProvider>
      </div>
      <FontMamDialog open={fontMamOpen} onClose={() => setFontMamOpen(false)} />
    </div>
  );
}

function PropertiesToolbar({
  signal,
  onChange,
}: {
  signal: SectionCollapseSignal;
  onChange: (signal: SectionCollapseSignal) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
      <span className="text-[12px] font-semibold text-ink-muted">Properties</span>
      <CollapseAllButton signal={signal} onChange={onChange} />
    </div>
  );
}

function TransformSection({
  id, kind, t, layerType, canvas, visualBox, updateTransform, updateGroupPivot,
}: {
  id: string;
  kind: 'layer' | 'group';
  t: Layer['transform'];
  layerType?: Layer['type'];
  canvas: { width: number; height: number };
  visualBox?: { x: number; y: number; width: number; height: number } | null;
  updateTransform: (id: string, partial: Partial<Layer['transform']>, kind?: 'layer' | 'group') => void;
  updateGroupPivot?: (id: string, partial: Partial<Layer['transform']>) => void;
}) {
  const [scaleLocked, setScaleLocked] = useState(false);
  const set = (partial: Partial<Layer['transform']>) => updateTransform(id, partial, kind);
  const setPivot = (partial: Partial<Layer['transform']>) => {
    if (kind === 'group' && visualBox && updateGroupPivot) {
      updateGroupPivot(id, partial);
      return;
    }
    set(partial);
  };
  const setScale = (next: Partial<Pick<Layer['transform'], 'scaleX' | 'scaleY'>>) => {
    set(scaleLocked ? lockedScale(t, next) : next);
  };
  const previewPartial = (partial: Partial<Layer['transform']> | null) => {
    if (partial === null) {
      clearGesturePreview();
      return;
    }
    scheduleGesturePreview({ id, kind, transform: { ...t, ...partial } });
  };
  const previewScale = (next: Partial<Pick<Layer['transform'], 'scaleX' | 'scaleY'>> | null) => {
    if (next === null) {
      clearGesturePreview();
      return;
    }
    previewPartial(scaleLocked ? lockedScale(t, next) : next);
  };
  const dimensions = layerType && layerType in LAYER_DEFAULT_DIMENSIONS
    ? LAYER_DEFAULT_DIMENSIONS[layerType as keyof typeof LAYER_DEFAULT_DIMENSIONS]
    : null;

  return (
    <>
      {has25dCost(t) && (
        <div className="border-b border-border px-3 py-2">
          <p role="status" className="text-[12px] text-warning">
            2.5D (Z or tilt) makes the frame more expensive. Use it only when layers need to intersect in depth.
          </p>
        </div>
      )}

      {kind === 'layer' && (
        <Section title="Size">
          <div className="flex flex-wrap gap-1">
            <ChromeButton aria-label="Fit to canvas" onClick={() => set(canvasFitSize(canvas, 'screen', t))}>Screen</ChromeButton>
            <ChromeButton aria-label="Fit width to canvas" onClick={() => set(canvasFitSize(canvas, 'width', t))}>Width</ChromeButton>
            <ChromeButton aria-label="Fit height to canvas" onClick={() => set(canvasFitSize(canvas, 'height', t))}>Height</ChromeButton>
          </div>
          <LabeledNum
            label="Width"
            value={t.width}
            resetValue={dimensions?.width}
            onChange={(v) => set({ width: v })}
            onPreview={(v) => previewPartial(v === null ? null : { width: v })}
          />
          <LabeledNum
            label="Height"
            value={t.height}
            resetValue={dimensions?.height}
            onChange={(v) => set({ height: v })}
            onPreview={(v) => previewPartial(v === null ? null : { height: v })}
          />
          <ScalePair
            scaleX={t.scaleX}
            scaleY={t.scaleY}
            locked={scaleLocked}
            onToggleLock={() => setScaleLocked((current) => !current)}
            onChangeX={(v) => setScale({ scaleX: v })}
            onChangeY={(v) => setScale({ scaleY: v })}
            onPreviewX={(v) => previewScale(v === null ? null : { scaleX: v })}
            onPreviewY={(v) => previewScale(v === null ? null : { scaleY: v })}
          />
        </Section>
      )}

      <Section title="Position">
        <LabeledNum label="X" value={t.x} resetValue={0} onChange={(v) => set({ x: v })} onPreview={(v) => previewPartial(v === null ? null : { x: v })} />
        <LabeledNum label="Y" value={t.y} resetValue={0} onChange={(v) => set({ y: v })} onPreview={(v) => previewPartial(v === null ? null : { y: v })} />
        <LabeledNum label="Z" value={t.z ?? 0} resetValue={0} onChange={(v) => set({ z: v })} onPreview={(v) => previewPartial(v === null ? null : { z: v })} />

        <Subheading>Rotation</Subheading>
        <LabeledNum
          label="X"
          value={t.rotationX}
          resetValue={0}
          onChange={(v) => set({ rotationX: v })}
          onPreview={(v) => previewPartial(v === null ? null : { rotationX: v })}
          extraActions={(
            <AngleActions
              label="X rotation"
              onNudge={(direction) => set({ rotationX: nudgeAngle45(t.rotationX, direction) })}
            />
          )}
        />
        <LabeledNum
          label="Y"
          value={t.rotationY}
          resetValue={0}
          onChange={(v) => set({ rotationY: v })}
          onPreview={(v) => previewPartial(v === null ? null : { rotationY: v })}
          extraActions={(
            <AngleActions
              label="Y rotation"
              onNudge={(direction) => set({ rotationY: nudgeAngle45(t.rotationY, direction) })}
            />
          )}
        />
        <LabeledNum
          label="Z"
          value={t.rotation}
          resetValue={0}
          onChange={(v) => set({ rotation: v })}
          onPreview={(v) => previewPartial(v === null ? null : { rotation: v })}
          extraActions={(
            <AngleActions
              label="rotation"
              onNudge={(direction) => set({ rotation: nudgeAngle45(t.rotation, direction) })}
            />
          )}
        />

        <LabeledNum
          label="Perspective"
          value={t.perspective}
          resetValue={1000}
          onChange={(v) => set({ perspective: v })}
          onPreview={(v) => previewPartial(v === null ? null : { perspective: v })}
        />

        {kind === 'group' && (
          <ScalePair
            scaleX={t.scaleX}
            scaleY={t.scaleY}
            locked={scaleLocked}
            onToggleLock={() => setScaleLocked((current) => !current)}
            onChangeX={(v) => setScale({ scaleX: v })}
            onChangeY={(v) => setScale({ scaleY: v })}
            onPreviewX={(v) => previewScale(v === null ? null : { scaleX: v })}
            onPreviewY={(v) => previewScale(v === null ? null : { scaleY: v })}
          />
        )}

        <Subheading>Axis center</Subheading>
        <LabeledNum
          label="X"
          value={t.anchorX}
          resetValue={0}
          step={0.05}
          onChange={(v) => setPivot(visualBox
            ? anchorCompensatedUpdateForBox(t, visualBox, { anchorX: v })
            : anchorCompensatedUpdate(t, { anchorX: v }))}
          onPreview={(v) => previewPartial(v === null ? null : (visualBox
            ? anchorCompensatedUpdateForBox(t, visualBox, { anchorX: v })
            : anchorCompensatedUpdate(t, { anchorX: v })))}
          extraActions={(
            <AxisPresets
              axis="x"
              current={t.anchorX}
              onPick={(preset) => setPivot(visualBox ? axisPresetXForBox(t, visualBox, preset) : axisPresetX(t, preset))}
            />
          )}
        />
        <LabeledNum
          label="Y"
          value={t.anchorY}
          resetValue={0}
          step={0.05}
          onChange={(v) => setPivot(visualBox
            ? anchorCompensatedUpdateForBox(t, visualBox, { anchorY: v })
            : anchorCompensatedUpdate(t, { anchorY: v }))}
          onPreview={(v) => previewPartial(v === null ? null : (visualBox
            ? anchorCompensatedUpdateForBox(t, visualBox, { anchorY: v })
            : anchorCompensatedUpdate(t, { anchorY: v })))}
          extraActions={(
            <AxisPresets
              axis="y"
              current={t.anchorY}
              onPick={(preset) => setPivot(visualBox ? axisPresetYForBox(t, visualBox, preset) : axisPresetY(t, preset))}
            />
          )}
        />
      </Section>
    </>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return (
    <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
      {children}
    </h4>
  );
}

function ScalePair({
  scaleX,
  scaleY,
  locked,
  onToggleLock,
  onChangeX,
  onChangeY,
  onPreviewX,
  onPreviewY,
}: {
  scaleX: number;
  scaleY: number;
  locked: boolean;
  onToggleLock: () => void;
  onChangeX: (v: number) => void;
  onChangeY: (v: number) => void;
  onPreviewX: (v: number | null) => void;
  onPreviewY: (v: number | null) => void;
}) {
  const xId = useId();
  const yId = useId();
  return (
    <div className="relative grid grid-cols-[88px_1fr] gap-x-2 gap-y-2">
      <label htmlFor={xId} className="truncate text-[12px] text-ink-muted">Scale X</label>
      <NumberInput
        id={xId}
        value={scaleX}
        step={0.05}
        stepper
        aria-label="Scale X"
        resetValue={1}
        onChange={onChangeX}
        onPreview={onPreviewX}
      />
      <label htmlFor={yId} className="truncate text-[12px] text-ink-muted">Scale Y</label>
      <NumberInput
        id={yId}
        value={scaleY}
        step={0.05}
        stepper
        aria-label="Scale Y"
        resetValue={1}
        onChange={onChangeY}
        onPreview={onPreviewY}
      />
      <button
        type="button"
        data-chrome-control
        aria-label={locked ? 'Unlock scale axes' : 'Lock scale axes'}
        title={locked ? 'Unlock scale' : 'Lock scale'}
        aria-pressed={locked}
        onClick={onToggleLock}
        className={cn(
          'absolute left-[70px] top-1/2 z-10 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md border border-border bg-surface-2 text-ink-muted hover:border-ink-faint hover:text-ink',
          locked && 'border-primary text-primary',
        )}
      >
        {locked
          ? <Link2 className="h-3.5 w-3.5" aria-hidden />
          : <Link2Off className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </div>
  );
}


const CHROME_BUTTON =
  'grid h-8 min-w-7 place-items-center rounded-md border border-border bg-surface-2 px-1.5 ' +
  'text-[10px] font-semibold tabular-nums text-ink-muted hover:border-ink-faint hover:text-ink ' +
  'aria-pressed:border-primary aria-pressed:text-primary';

function ChromeButton({
  children,
  onClick,
  pressed,
  title,
  ...props
}: {
  children: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  title?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'type'>) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      className={CHROME_BUTTON}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}

function AxisPresets({
  axis,
  current,
  onPick,
}: {
  axis: 'x' | 'y';
  current: number;
  onPick: (preset: AxisPreset) => void;
}) {
  const presets: Array<{ value: AxisPreset; label: string; name: string }> = axis === 'x'
    ? [
        { value: 0, label: 'L', name: 'left' },
        { value: 0.5, label: 'C', name: 'center' },
        { value: 1, label: 'R', name: 'right' },
      ]
    : [
        { value: 1, label: 'B', name: 'bottom' },
        { value: 0.5, label: 'C', name: 'center' },
        { value: 0, label: 'T', name: 'top' },
      ];
  return (
    <>
      {presets.map((preset) => (
        <ChromeButton
          key={`${axis}-${preset.label}`}
          pressed={Math.abs(current - preset.value) < 1e-6}
          aria-label={`Set ${axis === 'x' ? 'horizontal' : 'vertical'} axis to ${preset.name}`}
          title={preset.name}
          onClick={() => onPick(preset.value)}
        >
          {preset.label}
        </ChromeButton>
      ))}
    </>
  );
}

function LabeledNum({
  label,
  value,
  onChange,
  onPreview,
  step,
  resetValue,
  min,
  max,
  extraActions,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onPreview?: (v: number | null) => void;
  step?: number;
  resetValue?: number;
  min?: number;
  max?: number;
  extraActions?: ReactNode;
}) {
  const inputId = useId();
  return (
    <Field label={label} htmlFor={inputId}>
      <NumberInput
        id={inputId}
        value={value}
        min={min}
        max={max}
        step={step}
        stepper
        aria-label={label}
        resetValue={resetValue}
        extraActions={extraActions}
        onChange={onChange}
        onPreview={onPreview ?? ((v) => { if (v !== null) onChange(v); })}
      />
    </Field>
  );
}

function AngleActions({
  label,
  onNudge,
}: {
  label: string;
  onNudge: (direction: -1 | 1) => void;
}) {
  const buttonClass =
    'grid h-8 min-w-7 place-items-center rounded-md border border-border bg-surface-2 px-1 ' +
    'text-[10px] font-semibold tabular-nums text-ink-muted hover:border-ink-faint hover:text-ink';
  return (
    <>
      <button
        type="button"
        className={buttonClass}
        aria-label={`Increase ${label} by 45 degrees`}
        title="+45°"
        onClick={() => onNudge(1)}
      >
        +45
      </button>
      <button
        type="button"
        className={buttonClass}
        aria-label={`Decrease ${label} by 45 degrees`}
        title="-45°"
        onClick={() => onNudge(-1)}
      >
        -45
      </button>
    </>
  );
}

type UpdateLayer = (id: string, mutator: (l: Layer) => void) => void;
type SetGradientWeight = (id: string, prop: AnimatableProp, value: number) => void;

function TypeSection({
  layer,
  variables,
  updateLayer,
  setGradientWeight,
  onOpenFontMam,
  weightValue,
}: {
  layer: Layer;
  variables: Variable[];
  updateLayer: UpdateLayer;
  setGradientWeight?: SetGradientWeight;
  onOpenFontMam?: () => void;
  weightValue?: (prop: AnimatableProp, base: number) => number;
}) {
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
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} onOpenFontMam={onOpenFontMam ?? (() => {})} />
        </>
      );
    case 'rect':
      return (
        <Section title="Rectangle">
          <Field label="Fill mode">
            <div className="flex flex-wrap gap-1">
              <ChromeButton
                pressed={(layer.fillMode ?? 'solid') === 'solid'}
                aria-label="Solid fill"
                onClick={() => updateLayer(layer.id, (l) => {
                  if (l.type !== 'rect') return;
                  l.fillMode = 'solid';
                  delete (l as { gradient?: unknown }).gradient;
                })}
              >
                Solid
              </ChromeButton>
              <ChromeButton
                pressed={layer.fillMode === 'gradient'}
                aria-label="Gradient fill"
                onClick={() => updateLayer(layer.id, (l) => {
                  if (l.type !== 'rect') return;
                  if (l.fillMode === 'gradient') return;
                  const fill = typeof l.fill === 'string' ? l.fill : '#1f2937';
                  const next = l as unknown as {
                    fillMode: 'gradient';
                    gradient: {
                      topLeft: string; topRight: string; bottomLeft: string; bottomRight: string;
                      weights: { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };
                    };
                  };
                  next.fillMode = 'gradient';
                  next.gradient = {
                    topLeft: fill, topRight: fill, bottomLeft: fill, bottomRight: fill,
                    weights: { topLeft: 100, topRight: 100, bottomLeft: 100, bottomRight: 100 },
                  };
                })}
              >
                Gradient
              </ChromeButton>
            </div>
          </Field>
          {(layer.fillMode ?? 'solid') === 'solid' && (
            <Field label="Fill">
              <BindableField
                kind="color"
                value={layer.fill}
                variables={variables}
                onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.fill = v; })}
              />
            </Field>
          )}
          {layer.fillMode === 'gradient' && layer.gradient && (
            <>
              <Field label="Top left">
                <ColorInput value={layer.gradient.topLeft} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect' && l.gradient) l.gradient.topLeft = v; })} />
              </Field>
              <Field label="Top right">
                <ColorInput value={layer.gradient.topRight} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect' && l.gradient) l.gradient.topRight = v; })} />
              </Field>
              <Field label="Bottom left">
                <ColorInput value={layer.gradient.bottomLeft} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect' && l.gradient) l.gradient.bottomLeft = v; })} />
              </Field>
              <Field label="Bottom right">
                <ColorInput value={layer.gradient.bottomRight} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect' && l.gradient) l.gradient.bottomRight = v; })} />
              </Field>
              <LabeledNum
                label="Weight TL"
                value={weightValue?.('gradient.weights.topLeft', layer.gradient.weights.topLeft) ?? layer.gradient.weights.topLeft}
                min={0}
                max={100}
                resetValue={100}
                onChange={(v) => setGradientWeight?.(layer.id, 'gradient.weights.topLeft', v)}
              />
              <LabeledNum
                label="Weight TR"
                value={weightValue?.('gradient.weights.topRight', layer.gradient.weights.topRight) ?? layer.gradient.weights.topRight}
                min={0}
                max={100}
                resetValue={100}
                onChange={(v) => setGradientWeight?.(layer.id, 'gradient.weights.topRight', v)}
              />
              <LabeledNum
                label="Weight BL"
                value={weightValue?.('gradient.weights.bottomLeft', layer.gradient.weights.bottomLeft) ?? layer.gradient.weights.bottomLeft}
                min={0}
                max={100}
                resetValue={100}
                onChange={(v) => setGradientWeight?.(layer.id, 'gradient.weights.bottomLeft', v)}
              />
              <LabeledNum
                label="Weight BR"
                value={weightValue?.('gradient.weights.bottomRight', layer.gradient.weights.bottomRight) ?? layer.gradient.weights.bottomRight}
                min={0}
                max={100}
                resetValue={100}
                onChange={(v) => setGradientWeight?.(layer.id, 'gradient.weights.bottomRight', v)}
              />
            </>
          )}
          <LabeledNum label="Radius" value={layer.cornerRadius} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.cornerRadius = v; })} />
          <LabeledNum label="Border" value={layer.borderWidth} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.borderWidth = v; })} />
          <Field label="Border color">
            <ColorInput value={layer.borderColor} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.borderColor = v; })} />
          </Field>
        </Section>
      );
    case 'mask':
      return (
        <Section title="Mask">
          <Field label="Mode">
            <Select value={layer.maskMode} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.maskMode = e.target.value as 'normal' | 'inverted'; })}>
              <option value="normal">normal</option>
              <option value="inverted">inverted</option>
            </Select>
          </Field>
          <Field label="Shape">
            <Select value={layer.shape} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.shape = e.target.value as 'rect' | 'ellipse'; })}>
              <option value="rect">rect</option>
              <option value="ellipse">ellipse</option>
            </Select>
          </Field>
          <LabeledNum label="Radius" value={layer.cornerRadius} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.cornerRadius = v; })} />
        </Section>
      );
    case 'image':
    case 'video':
      return (
        <Section title={layer.type === 'image' ? 'Image' : 'Video'}>
          <Field label="Source">
            <BindableField
              kind="text"
              value={layer.src}
              variables={variables}
              onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.src = v; })}
            />
          </Field>
          {typeof layer.src === 'string' && layer.src && (
            <SelectedMediaInfo src={layer.src} />
          )}
          {typeof layer.src !== 'object' && (
            <div className="space-y-1">
              <MamPicker
                kind={layer.type === 'image' ? 'image' : 'video'}
                accept={layer.type === 'image' ? 'image/*' : 'video/*'}
                onPick={(token) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.src = token; })}
              />
              <MediaUploadButton
                accept={layer.type === 'image' ? 'image/*' : 'video/*'}
                onUploaded={(url) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.src = url; })}
              />
            </div>
          )}
          <Field label="Fit">
            <Select value={layer.fit} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.fit = e.target.value as 'stretch' | 'contain' | 'cover'; })}>
              <option value="cover">cover</option>
              <option value="contain">contain</option>
              <option value="stretch">stretch</option>
            </Select>
          </Field>
          {layer.type === 'image' && (
            <LabeledNum label="Radius" value={layer.cornerRadius} resetValue={0} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'image') l.cornerRadius = v; })} />
          )}
          {layer.type === 'video' && (
            <>
              <Checkbox label="Loop" checked={layer.loop} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'video') l.loop = v; })} />
              <LabeledNum
                label="In"
                value={layer.inFrame ?? 0}
                resetValue={0}
                onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'video') l.inFrame = Math.max(0, Math.round(v)); })}
              />
              <LabeledNum
                label="Out"
                value={layer.outFrame ?? 0}
                resetValue={0}
                onChange={(v) => updateLayer(layer.id, (l) => {
                  if (l.type !== 'video') return;
                  const next = Math.max(0, Math.round(v));
                  if (next === 0) delete l.outFrame;
                  else l.outFrame = next;
                })}
              />
            </>
          )}
        </Section>
      );
    case 'clock':
      return (
        <>
          <Section title="Clock">
            <Field label="Mode">
              <Select value={layer.mode} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'clock') l.mode = e.target.value as 'clock' | 'countup' | 'countdown'; })}>
                <option value="clock">clock</option>
                <option value="countup">countup</option>
                <option value="countdown">countdown</option>
              </Select>
            </Field>
            <Field label="Format">
              <Input value={layer.format} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'clock') l.format = e.target.value; })} />
            </Field>
            {layer.mode === 'countup' && (
              <Field label="Start">
                <ClockAnchorField
                  value={layer.startTime}
                  variables={variables}
                  onChange={(value) => updateLayer(layer.id, (l) => { if (l.type === 'clock') l.startTime = value; })}
                />
              </Field>
            )}
            {layer.mode === 'countdown' && (
              <Field label="Target">
                <ClockAnchorField
                  value={layer.targetTime}
                  variables={variables}
                  onChange={(value) => updateLayer(layer.id, (l) => { if (l.type === 'clock') l.targetTime = value; })}
                />
              </Field>
            )}
          </Section>
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} onOpenFontMam={onOpenFontMam ?? (() => {})} />
        </>
      );
    case 'crawl':
      return (
        <>
          <Section title="Content">
            <BindableField
              kind="text"
              value={layer.content}
              variables={variables}
              onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'crawl') l.content = v; })}
            />
          </Section>
          <Section title="Crawl">
            <CrawlProperties layer={layer} updateLayer={(id, mutator) => updateLayer(id, (l) => { if (l.type === 'crawl') mutator(l); })} />
          </Section>
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} onOpenFontMam={onOpenFontMam ?? (() => {})} />
        </>
      );
  }
}

function TextStyleSection({ layer, variables, updateLayer, onOpenFontMam }: { layer: Extract<Layer, { style: import('@runtime').TextStyle }>; variables: Variable[]; updateLayer: UpdateLayer; onOpenFontMam: () => void }) {
  const s = layer.style;
  const setStyle = (mutator: (st: import('@runtime').TextStyle) => void) =>
    updateLayer(layer.id, (l) => { if ('style' in l) mutator(l.style); });
  return (
    <Section title="Text style">
      <Field label="Font">
        <div className="flex gap-1">
          <FontFamilySelect value={s.fontFamily} onChange={(family) => setStyle((st) => { st.fontFamily = family; })} />
          <button
            type="button"
            title="Font MAM"
            onClick={onOpenFontMam}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-2"
          >
            MAM
          </button>
        </div>
      </Field>
      <LabeledNum label="Size" value={s.fontSize} resetValue={48} onChange={(v) => setStyle((st) => { st.fontSize = v; })} />
      <Field label="Weight">
        <Select value={s.fontWeight} onChange={(e) => setStyle((st) => { st.fontWeight = e.target.value; })}>
          {['300', '400', '500', '600', '700', '800', '900'].map((w) => <option key={w} value={w}>{w}</option>)}
        </Select>
      </Field>
      <Field label="Color">
        <BindableField kind="color" value={s.fill} variables={variables} onChange={(v) => setStyle((st) => { st.fill = v; })} />
      </Field>
      <Field label="Align">
        <Select value={s.align} onChange={(e) => setStyle((st) => { st.align = e.target.value as 'left' | 'center' | 'right'; })}>
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </Select>
      </Field>
      <LabeledNum label="Line height" value={s.lineHeight} resetValue={1.1} step={0.05} onChange={(v) => setStyle((st) => { st.lineHeight = v; })} />
      <LabeledNum label="Spacing" value={s.letterSpacing} resetValue={0} onChange={(v) => setStyle((st) => { st.letterSpacing = v; })} />
      <Field label="Transform">
        <div className="flex gap-1">
          {([
            ['none', 'x'],
            ['uppercase', 'AA'],
            ['titlecase', 'Aa'],
            ['lowercase', 'aa'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={cn(
                'h-8 min-w-8 rounded-md border px-2 text-[12px]',
                (s.textTransform ?? 'none') === mode
                  ? 'border-primary text-primary'
                  : 'border-border text-ink-muted',
              )}
              onClick={() => setStyle((st) => {
                if (mode === 'none') delete st.textTransform;
                else st.textTransform = mode;
              })}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      <Checkbox
        label="Drop shadow"
        checked={s.dropShadow}
        onChange={(v) => setStyle((st) => {
          st.dropShadow = v;
          if (v) {
            st.dropShadowOffsetX ??= 0;
            st.dropShadowOffsetY ??= st.dropShadowDistance;
          }
        })}
      />
      {s.dropShadow && (
        <>
          <Field label="Shadow color">
            <ColorInput value={s.dropShadowColor} onChange={(c) => setStyle((st) => { st.dropShadowColor = c; })} />
          </Field>
          <LabeledNum label="Shadow X" value={s.dropShadowOffsetX ?? 0} resetValue={0} onChange={(v) => setStyle((st) => { st.dropShadowOffsetX = v; })} />
          <LabeledNum label="Shadow Y" value={s.dropShadowOffsetY ?? s.dropShadowDistance} resetValue={s.dropShadowDistance} onChange={(v) => setStyle((st) => { st.dropShadowOffsetY = v; st.dropShadowDistance = v; })} />
          <LabeledNum label="Shadow blur" value={s.dropShadowBlur} resetValue={6} onChange={(v) => setStyle((st) => { st.dropShadowBlur = v; })} />
        </>
      )}
    </Section>
  );
}


function ClockAnchorField({
  value,
  onChange,
  variables,
}: {
  value: number | VariableBinding | undefined;
  onChange: (v: number | VariableBinding | undefined) => void;
  variables: Variable[];
}) {
  const timeVars = variables.filter((item) => item.type === 'time');
  const pool = timeVars.length > 0 ? timeVars : variables;
  const isBound = typeof value === 'object' && value !== null;
  return (
    <div className="flex items-center gap-1.5">
      {isBound ? (
        <Select
          className="flex-1"
          value={value.variableId}
          onChange={(e) => onChange({ type: 'variable', variableId: e.target.value })}
        >
          {pool.length === 0 && <option value="">No variables</option>}
          {pool.map((v) => <option key={v.id} value={v.id}>{v.label || v.name}</option>)}
        </Select>
      ) : (
        <Input
          className="flex-1"
          value={value == null ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onChange(raw === '' ? undefined : Number(raw));
          }}
          placeholder="epoch ms"
        />
      )}
      <button
        title={isBound ? 'Unbind variable' : 'Bind to variable'}
        disabled={!isBound && pool.length === 0}
        onClick={() => {
          if (isBound) onChange(undefined);
          else if (pool[0]) onChange({ type: 'variable', variableId: pool[0].id });
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
