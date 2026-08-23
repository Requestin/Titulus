import { useState } from 'react';
import type { DataOnError, DataPipeline, DataSelect, DataSource, DataSourceFormat, DataSourceType, Template } from '@runtime';
import { api, ApiError } from '@/core/api';
import { toast } from '@/core/toast';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import { createId } from '@/core/id';
import { useEditor } from '../store';

const SOURCE_TYPES: DataSourceType[] = ['inline', 'textfile', 'jsonfile'];
const FORMATS: DataSourceFormat[] = ['lines', 'delimited', 'kv', 'json'];
const SELECTS: DataSelect['mode'][] = ['first', 'last', 'index', 'byKey', 'match', 'all'];
const ERRORS: DataOnError[] = ['block', 'keep', 'clear'];

function ensureData(template: Template): NonNullable<Template['data']> {
  return template.data ?? { version: 1, sources: [], pipelines: [], runOn: ['take'], onError: 'block' };
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
      const result = await api.templates.prepare({ template: current, trigger: 'refresh' });
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
                const pipeline: DataPipeline = {
                  id: createId(),
                  sourceId,
                  select: { mode: 'first' },
                  map: [{ from: 'line', to: { type: 'variable', variableId: template.variables[0]?.id || '' } }],
                };
                next.pipelines.push(pipeline);
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
  const entry = pipeline.map[0];
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
      <div className="flex gap-2">
        <Select value={pipeline.sourceId} onChange={(e) => onChange({ sourceId: e.target.value })} className="flex-1">
          {sources.map((source) => <option key={source.id} value={source.id}>{source.id}</option>)}
        </Select>
        <Select
          value={pipeline.select.mode}
          onChange={(e) => onChange({ select: { mode: e.target.value } as DataSelect })}
          className="w-24"
        >
          {SELECTS.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <button className="text-[12px] text-danger" onClick={onRemove}>Remove</button>
      </div>
      <div className="flex gap-2">
        <Input
          value={entry?.from ?? ''}
          onChange={(e) => onChange({ map: [{ ...entry, from: e.target.value, to: entry?.to ?? { type: 'variable', variableId: '' } }] as DataPipeline['map'] })}
          placeholder="from"
        />
        <Select
          value={entry?.to.variableId ?? ''}
          onChange={(e) => onChange({ map: [{ ...entry, from: entry?.from ?? 'line', to: { type: 'variable', variableId: e.target.value } }] as DataPipeline['map'] })}
        >
          {variables.map((variable) => <option key={variable.id} value={variable.id}>{variable.name}</option>)}
        </Select>
      </div>
    </div>
  );
}
