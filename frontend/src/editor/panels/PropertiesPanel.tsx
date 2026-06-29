// frontend/src/editor/panels/PropertiesPanel.tsx
//
// Inspector for the current selection: base props, transform, type-specific
// style, and variable bindings on string fields (content / fill / src).

import { Braces } from 'lucide-react';
import type { Layer, Variable, VariableBinding, BlendMode } from '@runtime';
import { anchorCompensatedUpdate } from '@runtime';
import { useEditor } from '../store';
import { MediaUploadButton } from '../MediaUploadButton';
import { Field, Section, Input, NumberInput, Select, ColorInput, Checkbox } from '@/components/ui/form';
import { cn } from '@/lib/cn';

const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten'];

export function PropertiesPanel() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const updateLayer = useEditor((s) => s.updateLayer);
  const updateTransform = useEditor((s) => s.updateTransform);
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
          <Field label="Name">
            <Input value={g.name} onChange={(e) => patch((t) => { const x = t.groups.find((q) => q.id === g.id); if (x) x.name = e.target.value; })} />
          </Field>
        </Section>
        <TransformSection id={g.id} kind="group" t={g.transform} updateTransform={updateTransform} />
      </div>
    );
  }

  const layer = template.layers.find((l) => l.id === selection.id);
  if (!layer) return null;

  return (
    <div className="overflow-auto">
      <Section title="Layer">
        <Field label="Name">
          <Input value={layer.name} onChange={(e) => updateLayer(layer.id, (l) => { l.name = e.target.value; })} />
        </Field>
        {layer.type !== 'mask' && (
          <>
            <Field label="Opacity">
              <NumberInput value={layer.opacity} min={0} max={1} step={0.05} onChange={(v) => updateLayer(layer.id, (l) => { l.opacity = Math.min(1, Math.max(0, v)); })} />
            </Field>
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

      <TransformSection id={layer.id} kind="layer" t={layer.transform} updateTransform={updateTransform} />

      <TypeSection layer={layer} variables={variables} updateLayer={updateLayer} />
    </div>
  );
}

function TransformSection({
  id, kind, t, updateTransform,
}: {
  id: string;
  kind: 'layer' | 'group';
  t: Layer['transform'];
  updateTransform: (id: string, partial: Partial<Layer['transform']>, kind?: 'layer' | 'group') => void;
}) {
  const set = (partial: Partial<Layer['transform']>) => updateTransform(id, partial, kind);
  return (
    <Section title="Transform">
      <div className="grid grid-cols-2 gap-2">
        <LabeledNum label="X" value={t.x} onChange={(v) => set({ x: v })} />
        <LabeledNum label="Y" value={t.y} onChange={(v) => set({ y: v })} />
        <LabeledNum label="W" value={t.width} onChange={(v) => set({ width: v })} />
        <LabeledNum label="H" value={t.height} onChange={(v) => set({ height: v })} />
        <LabeledNum label="Rotate" value={t.rotation} onChange={(v) => set({ rotation: v })} />
        <LabeledNum label="Tilt X" value={t.rotationX} onChange={(v) => set({ rotationX: v })} />
        <LabeledNum label="Tilt Y" value={t.rotationY} onChange={(v) => set({ rotationY: v })} />
        <LabeledNum label="Persp" value={t.perspective} onChange={(v) => set({ perspective: v })} />
        <LabeledNum label="Scale X" value={t.scaleX} step={0.05} onChange={(v) => set({ scaleX: v })} />
        <LabeledNum label="Scale Y" value={t.scaleY} step={0.05} onChange={(v) => set({ scaleY: v })} />
        <LabeledNum label="Anchor X" value={t.anchorX} step={0.05} onChange={(v) => set(anchorCompensatedUpdate(t, { anchorX: v }))} />
        <LabeledNum label="Anchor Y" value={t.anchorY} step={0.05} onChange={(v) => set(anchorCompensatedUpdate(t, { anchorY: v }))} />
      </div>
    </Section>
  );
}

function LabeledNum({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[12px] text-ink-muted">{label}</span>
      <NumberInput value={value} step={step} onChange={onChange} />
    </label>
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
          <Field label="Fill">
            <BindableField
              kind="color"
              value={layer.fill}
              variables={variables}
              onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.fill = v; })}
            />
          </Field>
          <Field label="Radius">
            <NumberInput value={layer.cornerRadius} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.cornerRadius = v; })} />
          </Field>
          <Field label="Border">
            <NumberInput value={layer.borderWidth} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'rect') l.borderWidth = v; })} />
          </Field>
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
          <Field label="Radius">
            <NumberInput value={layer.cornerRadius} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'mask') l.cornerRadius = v; })} />
          </Field>
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
          {typeof layer.src !== 'object' && (
            <MediaUploadButton
              accept={layer.type === 'image' ? 'image/*' : 'video/*'}
              onUploaded={(url) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.src = url; })}
            />
          )}
          <Field label="Fit">
            <Select value={layer.fit} onChange={(e) => updateLayer(layer.id, (l) => { if (l.type === 'image' || l.type === 'video') l.fit = e.target.value as 'stretch' | 'contain' | 'cover'; })}>
              <option value="cover">cover</option>
              <option value="contain">contain</option>
              <option value="stretch">stretch</option>
            </Select>
          </Field>
          {layer.type === 'image' && (
            <Field label="Radius">
              <NumberInput value={layer.cornerRadius} onChange={(v) => updateLayer(layer.id, (l) => { if (l.type === 'image') l.cornerRadius = v; })} />
            </Field>
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
          </Section>
          <TextStyleSection layer={layer} variables={variables} updateLayer={updateLayer} />
        </>
      );
  }
}

function TextStyleSection({ layer, variables, updateLayer }: { layer: Extract<Layer, { style: import('@runtime').TextStyle }>; variables: Variable[]; updateLayer: UpdateLayer }) {
  const s = layer.style;
  const setStyle = (mutator: (st: import('@runtime').TextStyle) => void) =>
    updateLayer(layer.id, (l) => { if ('style' in l) mutator(l.style); });
  return (
    <Section title="Text style">
      <Field label="Font">
        <Input value={s.fontFamily} onChange={(e) => setStyle((st) => { st.fontFamily = e.target.value; })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <LabeledNum label="Size" value={s.fontSize} onChange={(v) => setStyle((st) => { st.fontSize = v; })} />
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-[12px] text-ink-muted">Weight</span>
          <Select value={s.fontWeight} onChange={(e) => setStyle((st) => { st.fontWeight = e.target.value; })}>
            {['300', '400', '500', '600', '700', '800', '900'].map((w) => <option key={w} value={w}>{w}</option>)}
          </Select>
        </label>
      </div>
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
      <div className="grid grid-cols-2 gap-2">
        <LabeledNum label="Line H" value={s.lineHeight} step={0.05} onChange={(v) => setStyle((st) => { st.lineHeight = v; })} />
        <LabeledNum label="Spacing" value={s.letterSpacing} onChange={(v) => setStyle((st) => { st.letterSpacing = v; })} />
      </div>
      <Checkbox label="Drop shadow" checked={s.dropShadow} onChange={(v) => setStyle((st) => { st.dropShadow = v; })} />
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
