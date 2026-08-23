import { useState } from 'react';
import type {
  DataMapAs,
  DataMapEntry,
  DataMissPolicy,
  DataOnError,
  DataPipeline,
  DataRunTrigger,
  DataSelect,
  DataSource,
  DataSourceFormat,
  DataSourceType,
  Template,
} from '@runtime';
import { api, ApiError } from '@/core/api';
import { toast } from '@/core/toast';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, Select } from '@/components/ui/form';
import { createId } from '@/core/id';
import { useEditor } from '../store';

const SOURCE_TYPES: DataSourceType[] = ['inline', 'textfile', 'jsonfile'];
const FORMATS: DataSourceFormat[] = ['lines', 'delimited', 'kv', 'json'];
const SELECTS: DataSelect['mode'][] = ['first', 'last', 'index', 'byKey', 'match', 'all'];
const ERRORS: DataOnError[] = ['block', 'keep', 'clear'];
const RUN_ON: DataRunTrigger[] = ['take', 'load', 'update', 'refresh'];
const MAP_AS: DataMapAs[] = ['text', 'multitext', 'number', 'time', 'image', 'video'];
const MISS: DataMissPolicy[] = ['keep', 'clear', 'block'];

function ensureData(template: Template): NonNullable<Template['data']> {
  return template.data ?? { version: 1, sources: [], pipelines: [], runOn: ['take'], onError: 'block' };
}

function defaultMap(variableId: string): DataMapEntry {
  return { from: 'line', to: { type: 'variable', variableId }, as: 'text' };
}

export function DataPanel() {
  const template = useEditor((s) => s.template);
  const patch = useEditor((s) => s.patch);
  const [preview, setPreview] = useState<string>('');
  const [busy, setBusy] = useState(false);
  if (!template) return null;
  const data = ensureData(template);

  function mutateData(mutator: (next: NonNullable<Template['data']>) => void) {
    patch((t) => {
      t.data = ensureData(t);
      mutator(t.data);
    });
  }

  async function runPreview() {
    setBusy(true);
    try {
      const current = template;
      if (!current) return;
      const trigger = (current.data?.runOn ?? ['take']).includes('refresh') ? 'refresh' : 'take';
      const result = await api.templates.prepare({ template: current, trigger });
      setPreview(JSON.stringify({ ok: result.ok, blocked: result.blocked, overrides: result.overrides, errors: result.errors }, null, 2));
      if (result.blocked) toast.error(result.errors[0]?.message || 'Data pipeline blocked');
      else toast.success('Preview prepared');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Prepare failed';
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Data</span>
        <Button size="sm" disabled={busy} onClick={() => void runPreview()}>
          Preview
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <label className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-ink-muted">onError</span>
          <Select
            value={data.onError ?? 'block'}
            onChange={(e) => mutateData((next) => { next.onError = e.target.value as DataOnError; })}
            className="w-28"
          >
            {ERRORS.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </label>
        <div className="space-y-1">
          <span className="text-[12px] text-ink-muted">runOn</span>
          <div className="flex flex-wrap gap-3">
            {RUN_ON.map((trigger) => (
              <Checkbox
                key={trigger}
                label={trigger}
                checked={(data.runOn ?? ['take']).includes(trigger)}
                onChange={(checked) => mutateData((next) => {
                  const current = new Set(next.runOn ?? ['take']);
                  if (checked) current.add(trigger);
                  else current.delete(trigger);
                  next.runOn = RUN_ON.filter((item) => current.has(item));
                })}
              />
            ))}
          </div>
        </div>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-ink-muted">Sources</h3>
            <button
              className="text-[12px] text-primary"
              onClick={() => mutateData((next) => {
                next.sources.push({
                  id: createId(),
                  type: 'inline',
                  format: 'lines',
                  content: '',
                  options: { commentPrefix: '#' },
                });
              })}
            >
              Add source
            </button>
          </div>
          {data.sources.map((source) => (
            <SourceCard key={source.id} source={source} onChange={(partial) => mutateData((next) => {
              const row = next.sources.find((item) => item.id === source.id);
              if (row) Object.assign(row, partial);
            })} onRemove={() => mutateData((next) => {
              next.sources = next.sources.filter((item) => item.id !== source.id);
            })}
            />
          ))}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-ink-muted">Pipelines</h3>
            <button
              className="text-[12px] text-primary"
              disabled={data.sources.length === 0}
              onClick={() => mutateData((next) => {
                const sourceId = next.sources[0]?.id;
                if (!sourceId) return;
                next.pipelines.push({
                  id: createId(),
                  sourceId,
                  select: { mode: 'first' },
                  map: [defaultMap(template.variables[0]?.id || '')],
                  onEmpty: 'keep',
                });
              })}
            >
              Add pipeline
            </button>
          </div>
          {data.pipelines.map((pipeline) => (
            <PipelineCard
              key={pipeline.id}
              pipeline={pipeline}
              sources={data.sources}
              variables={template.variables}
              onChange={(partial) => mutateData((next) => {
                const row = next.pipelines.find((item) => item.id === pipeline.id);
                if (row) Object.assign(row, partial);
              })}
              onRemove={() => mutateData((next) => {
                next.pipelines = next.pipelines.filter((item) => item.id !== pipeline.id);
              })}
            />
          ))}
        </section>

        {preview && (
          <pre className="whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 text-[11px] text-ink-muted">{preview}</pre>
        )}
      </div>
    </div>
  );
}

function SourceCard({
  source,
  onChange,
  onRemove,
}: {
  source: DataSource;
  onChange: (partial: Partial<DataSource>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
      <div className="flex gap-2">
        <Input value={source.id} onChange={(e) => onChange({ id: e.target.value })} className="flex-1" />
        <Select value={source.type} onChange={(e) => onChange({ type: e.target.value as DataSourceType })} className="w-24">
          {SOURCE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <Select value={source.format} onChange={(e) => onChange({ format: e.target.value as DataSourceFormat })} className="w-24">
          {FORMATS.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <button className="text-[12px] text-danger" onClick={onRemove}>Remove</button>
      </div>
      {source.type === 'inline' ? (
        <textarea
          value={source.content ?? ''}
          onChange={(e) => onChange({ content: e.target.value })}
          className="h-20 w-full rounded-md border border-border bg-surface-2 p-2 text-[12px]"
        />
      ) : (
        <Input
          value={source.path?.type === 'literal' ? source.path.value : ''}
          onChange={(e) => onChange({ path: { type: 'literal', value: e.target.value } } as Partial<DataSource>)}
          placeholder="/data-files/news.txt"
        />
      )}
      <Input
        value={source.options?.commentPrefix ?? ''}
        onChange={(e) => onChange({ options: { ...source.options, commentPrefix: e.target.value } })}
        placeholder="comment prefix"
      />
    </div>
  );
}

function PipelineCard({
  pipeline,
  sources,
  variables,
  onChange,
  onRemove,
}: {
  pipeline: DataPipeline;
  sources: DataSource[];
  variables: Template['variables'];
  onChange: (partial: Partial<DataPipeline>) => void;
  onRemove: () => void;
}) {
  function patchSelect(partial: Partial<DataSelect> & { mode: DataSelect['mode'] }) {
    onChange({ select: partial as DataSelect });
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
      <div className="flex gap-2">
        <Select value={pipeline.sourceId} onChange={(e) => onChange({ sourceId: e.target.value })} className="flex-1">
          {sources.map((source) => <option key={source.id} value={source.id}>{source.id}</option>)}
        </Select>
        <Select
          value={pipeline.select.mode}
          onChange={(e) => patchSelect({ mode: e.target.value as DataSelect['mode'] })}
          className="w-24"
        >
          {SELECTS.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <button className="text-[12px] text-danger" onClick={onRemove}>Remove</button>
      </div>
      {pipeline.select.mode === 'index' && (
        <Input
          type="number"
          value={pipeline.select.index}
          onChange={(e) => patchSelect({ mode: 'index', index: Number(e.target.value) || 0 })}
          placeholder="index"
        />
      )}
      {pipeline.select.mode === 'byKey' && (
        <div className="flex gap-2">
          <Input value={pipeline.select.key} onChange={(e) => patchSelect({ mode: 'byKey', key: e.target.value, value: pipeline.select.mode === 'byKey' ? pipeline.select.value : '' })} placeholder="key" />
          <Input value={pipeline.select.value} onChange={(e) => patchSelect({ mode: 'byKey', key: pipeline.select.mode === 'byKey' ? pipeline.select.key : '', value: e.target.value })} placeholder="value" />
        </div>
      )}
      {pipeline.select.mode === 'match' && (
        <div className="flex gap-2">
          <Input value={pipeline.select.key} onChange={(e) => patchSelect({ mode: 'match', key: e.target.value, pattern: pipeline.select.mode === 'match' ? pipeline.select.pattern : '' })} placeholder="key" />
          <Input value={pipeline.select.pattern} onChange={(e) => patchSelect({ mode: 'match', key: pipeline.select.mode === 'match' ? pipeline.select.key : '', pattern: e.target.value })} placeholder="pattern" />
        </div>
      )}
      {pipeline.map.map((entry, index) => (
        <div key={`${entry.from}-${index}`} className="flex flex-wrap gap-2">
          <Input
            value={entry.from}
            onChange={(e) => {
              const map = pipeline.map.map((item, itemIndex) => itemIndex === index ? { ...item, from: e.target.value } : item);
              onChange({ map: map as DataPipeline['map'] });
            }}
            placeholder="from"
          />
          <Select
            value={entry.to.variableId}
            onChange={(e) => {
              const map = pipeline.map.map((item, itemIndex) => itemIndex === index ? { ...item, to: { type: 'variable', variableId: e.target.value } } : item);
              onChange({ map: map as DataPipeline['map'] });
            }}
          >
            {variables.map((variable) => <option key={variable.id} value={variable.id}>{variable.name}</option>)}
          </Select>
          <Select
            value={entry.as ?? 'text'}
            onChange={(e) => {
              const map = pipeline.map.map((item, itemIndex) => itemIndex === index ? { ...item, as: e.target.value as DataMapAs } : item);
              onChange({ map: map as DataPipeline['map'] });
            }}
            className="w-24"
          >
            {MAP_AS.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
          {pipeline.map.length > 1 && (
            <button
              className="text-[12px] text-danger"
              onClick={() => onChange({ map: pipeline.map.filter((_, itemIndex) => itemIndex !== index) as DataPipeline['map'] })}
            >
              Remove map
            </button>
          )}
        </div>
      ))}
      <button
        className="text-[12px] text-primary"
        onClick={() => onChange({ map: [...pipeline.map, defaultMap(variables[0]?.id || '')] as DataPipeline['map'] })}
      >
        Add map
      </button>
      {pipeline.select.mode === 'all' && (
        <div className="flex gap-2">
          <Input
            value={pipeline.join?.field ?? ''}
            onChange={(e) => onChange({ join: { field: e.target.value, separator: pipeline.join?.separator ?? '\n' } })}
            placeholder="join field"
          />
          <Input
            value={pipeline.join?.separator ?? ''}
            onChange={(e) => onChange({ join: { field: pipeline.join?.field ?? 'line', separator: e.target.value } })}
            placeholder="join separator"
          />
        </div>
      )}
      <label className="flex items-center justify-between gap-2 text-[12px]">
        <span className="text-ink-muted">onEmpty</span>
        <Select
          value={pipeline.onEmpty ?? 'keep'}
          onChange={(e) => onChange({ onEmpty: e.target.value as DataMissPolicy })}
          className="w-28"
        >
          {MISS.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
      </label>
    </div>
  );
}
