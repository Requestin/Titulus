// frontend/src/editor/panels/DataPanel.tsx
//
// Designer UI for template.data: sources → select → map → driven variables.
// Control does not pick rows; this panel owns that logic.

import { useEffect, useState } from 'react';
import { Plus, Trash2, Play } from 'lucide-react';
import type {
  DataMapAs,
  DataPipeline,
  DataSelect,
  DataSource,
  DataSourceFormat,
  TemplateData,
} from '@runtime';
import { runTemplateData, resolveVariableMap } from '@runtime';
import { useEditor } from '../store';
import { Input, Select, NumberInput } from '@/components/ui/form';
import { Button } from '@/components/ui/Button';
import { createId } from '@/core/id';
import {
  readTemplateDataFile,
  resolveMediaTokenForPipeline,
} from '@/core/prepareTemplateData';
import { cn } from '@/lib/cn';

function emptyData(): TemplateData {
  return { version: 1, sources: [], pipelines: [], runOn: ['take', 'load'], onError: 'block' };
}

export function DataPanel() {
  const template = useEditor((s) => s.template);
  const ensureTemplateData = useEditor((s) => s.ensureTemplateData);
  const setTemplateData = useEditor((s) => s.setTemplateData);
  const patchTemplateData = useEditor((s) => s.patchTemplateData);
  const [preview, setPreview] = useState<string>('');
  const [busy, setBusy] = useState(false);

  if (!template) return null;

  const data = template.data;

  if (!data) {
    return (
      <div className="flex h-full flex-col p-3">
        <p className="mb-3 text-[12px] text-ink-muted">
          Bind a file inside the template: parse → select row → map into variables.
          Operators do not pick the row in Control.
        </p>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            ensureTemplateData();
            const d = emptyData();
            const srcId = createId();
            const pipeId = 'main';
            d.sources.push({
              id: srcId,
              type: 'textfile',
              format: 'delimited',
              path: { type: 'literal', value: '/uploads/data.txt' },
              options: {
                delimiter: '|',
                commentPrefix: '#',
                columns: ['name', 'title', 'photo'],
              },
            });
            d.pipelines.push({
              id: pipeId,
              sourceId: srcId,
              select: { mode: 'first' },
              map: [],
              mediaResolve: { strategy: ['assetId', 'url', 'path'], onMiss: 'clear' },
              onEmpty: 'block',
            });
            setTemplateData(d);
          }}
        >
          Enable Data pipeline
        </Button>
      </div>
    );
  }

  async function runPreview() {
    if (!template?.data) return;
    setBusy(true);
    try {
      const base = resolveVariableMap(template);
      const result = await runTemplateData(template, {
        trigger: 'load',
        variables: base,
        readFile: readTemplateDataFile,
        resolveMedia: resolveMediaTokenForPipeline,
      });
      setPreview(JSON.stringify({ ok: result.ok, overrides: result.overrides, errors: result.errors }, null, 2));
    } catch (err) {
      setPreview(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-ink-muted">Data</span>
        <button
          type="button"
          title="Remove data pipeline"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:text-danger"
          onClick={() => setTemplateData(undefined)}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-[11px] text-ink-muted">
            onError
            <Select
              value={data.onError ?? 'block'}
              onChange={(e) => patchTemplateData((d) => { d.onError = e.target.value as TemplateData['onError']; })}
            >
              <option value="block">block</option>
              <option value="keep">keep</option>
              <option value="clear">clear</option>
            </Select>
          </label>
          <label className="space-y-1 text-[11px] text-ink-muted">
            runOn
            <Input
              value={(data.runOn ?? ['take', 'load']).join(',')}
              onChange={(e) => {
                const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean) as TemplateData['runOn'];
                patchTemplateData((d) => { d.runOn = parts; });
              }}
              placeholder="take,load"
            />
          </label>
        </div>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-ink">Sources</h3>
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2"
              title="Add source"
              onClick={() => {
                patchTemplateData((d) => {
                  d.sources.push({
                    id: createId(),
                    type: 'textfile',
                    format: 'delimited',
                    path: { type: 'literal', value: '' },
                    options: { delimiter: '|', columns: ['col0', 'col1'] },
                  });
                });
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {data.sources.map((src) => (
            <SourceCard key={src.id} source={src} />
          ))}
          {data.sources.length === 0 && (
            <p className="text-[12px] text-ink-faint">No sources yet.</p>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-ink">Pipelines</h3>
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2"
              title="Add pipeline"
              onClick={() => {
                patchTemplateData((d) => {
                  const sourceId = d.sources[0]?.id ?? '';
                  d.pipelines.push({
                    id: `pipe_${createId().slice(0, 8)}`,
                    sourceId,
                    select: { mode: 'first' },
                    map: [],
                    mediaResolve: { strategy: ['assetId', 'url', 'path'], onMiss: 'clear' },
                  });
                });
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {data.pipelines.map((p) => (
            <PipelineCard key={p.id} pipeline={p} />
          ))}
          {data.pipelines.length === 0 && (
            <p className="text-[12px] text-ink-faint">No pipelines yet.</p>
          )}
        </section>

        <div className="space-y-2">
          <Button size="sm" variant="neutral" disabled={busy} onClick={() => void runPreview()}>
            <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
            Preview pipeline
          </Button>
          {preview && (
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-surface-2 p-2 text-[11px] text-ink-muted">
              {preview}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceCard({ source }: { source: DataSource }) {
  const patchTemplateData = useEditor((s) => s.patchTemplateData);
  const variables = useEditor((s) => s.template?.variables ?? []);

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={source.id}
          onChange={(e) => {
            const next = e.target.value;
            patchTemplateData((d) => {
              const s = d.sources.find((x) => x.id === source.id);
              if (s) s.id = next;
              for (const p of d.pipelines) {
                if (p.sourceId === source.id) p.sourceId = next;
              }
            });
          }}
          className="flex-1 font-mono text-[12px]"
          placeholder="source id"
        />
        <button
          type="button"
          className="grid h-7 w-7 place-items-center text-ink-faint hover:text-danger"
          onClick={() => patchTemplateData((d) => { d.sources = d.sources.filter((x) => x.id !== source.id); })}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Select
          value={source.type}
          onChange={(e) => {
            const type = e.target.value as DataSource['type'];
            patchTemplateData((d) => {
              const s = d.sources.find((x) => x.id === source.id);
              if (!s) return;
              s.type = type;
              if (type === 'inline') {
                delete s.path;
                s.content = s.content ?? '';
              } else {
                delete s.content;
                s.path = s.path ?? { type: 'literal', value: '' };
                if (type === 'jsonfile') s.format = 'json';
              }
            });
          }}
        >
          <option value="textfile">textfile</option>
          <option value="jsonfile">jsonfile</option>
          <option value="inline">inline</option>
        </Select>
        <Select
          value={source.format}
          onChange={(e) => {
            const format = e.target.value as DataSourceFormat;
            patchTemplateData((d) => {
              const s = d.sources.find((x) => x.id === source.id);
              if (s) s.format = format;
            });
          }}
        >
          <option value="lines">lines</option>
          <option value="delimited">delimited</option>
          <option value="kv">kv</option>
          <option value="json">json</option>
        </Select>
      </div>

      {source.type === 'inline' ? (
        <textarea
          value={source.content ?? ''}
          onChange={(e) => patchTemplateData((d) => {
            const s = d.sources.find((x) => x.id === source.id);
            if (s) s.content = e.target.value;
          })}
          className="min-h-[72px] w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-ink"
          spellCheck={false}
        />
      ) : (
        <div className="space-y-2">
          <Select
            value={source.path?.type ?? 'literal'}
            onChange={(e) => {
              const type = e.target.value as 'literal' | 'variable';
              patchTemplateData((d) => {
                const s = d.sources.find((x) => x.id === source.id);
                if (!s) return;
                s.path = type === 'literal'
                  ? { type: 'literal', value: source.path?.type === 'literal' ? source.path.value : '' }
                  : { type: 'variable', variableId: variables[0]?.id ?? '' };
              });
            }}
          >
            <option value="literal">path literal</option>
            <option value="variable">path from variable</option>
          </Select>
          {source.path?.type === 'variable' ? (
            <Select
              value={source.path.variableId}
              onChange={(e) => patchTemplateData((d) => {
                const s = d.sources.find((x) => x.id === source.id);
                if (s?.path?.type === 'variable') s.path.variableId = e.target.value;
              })}
            >
              {variables.map((v) => (
                <option key={v.id} value={v.id}>{v.label || v.name} ({v.type})</option>
              ))}
            </Select>
          ) : (
            <Input
              value={source.path?.type === 'literal' ? source.path.value : ''}
              placeholder="/uploads/guests.txt"
              onChange={(e) => patchTemplateData((d) => {
                const s = d.sources.find((x) => x.id === source.id);
                if (s) s.path = { type: 'literal', value: e.target.value };
              })}
            />
          )}
        </div>
      )}

      {source.format === 'delimited' && (
        <div className="space-y-2">
          <Input
            value={source.options?.delimiter ?? '|'}
            placeholder="delimiter (e.g. |)"
            onChange={(e) => patchTemplateData((d) => {
              const s = d.sources.find((x) => x.id === source.id);
              if (!s) return;
              s.options = { ...s.options, delimiter: e.target.value || '|' };
            })}
          />
          <ColumnsInput
            sourceId={source.id}
            columns={source.options?.columns}
          />
        </div>
      )}
    </div>
  );
}

/** Free-text columns editor — keeps trailing commas while typing (unlimited columns). */
function ColumnsInput({
  sourceId,
  columns,
}: {
  sourceId: string;
  columns?: string[];
}) {
  const patchTemplateData = useEditor((s) => s.patchTemplateData);
  const [text, setText] = useState(() => (columns ?? []).join(','));

  useEffect(() => {
    setText((columns ?? []).join(','));
    // Reset draft when switching source cards only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  return (
    <label className="block space-y-1 text-[11px] text-ink-muted">
      columns (comma-separated, any count)
      <Input
        value={text}
        placeholder="name,title,photo,extra,…"
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const parsed = raw
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
          patchTemplateData((d) => {
            const s = d.sources.find((x) => x.id === sourceId);
            if (!s) return;
            s.options = { ...s.options, columns: parsed };
          });
        }}
      />
    </label>
  );
}

function PipelineCard({ pipeline }: { pipeline: DataPipeline }) {
  const template = useEditor((s) => s.template);
  const patchTemplateData = useEditor((s) => s.patchTemplateData);
  const updateVariable = useEditor((s) => s.updateVariable);
  const sources = template?.data?.sources ?? [];
  const variables = template?.variables ?? [];

  function setSelect(mode: DataSelect['mode']) {
    patchTemplateData((d) => {
      const p = d.pipelines.find((x) => x.id === pipeline.id);
      if (!p) return;
      if (mode === 'index') p.select = { mode, index: 1 };
      else if (mode === 'byKey') p.select = { mode, key: 'id', value: '' };
      else if (mode === 'match') p.select = { mode, key: 'line', pattern: '.' };
      else p.select = { mode };
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={pipeline.id}
          className="flex-1 font-mono text-[12px]"
          onChange={(e) => {
            const next = e.target.value;
            patchTemplateData((d) => {
              const p = d.pipelines.find((x) => x.id === pipeline.id);
              if (p) p.id = next;
            });
            for (const v of variables) {
              if (v.drivenBy === pipeline.id) updateVariable(v.id, { drivenBy: next });
            }
          }}
        />
        <button
          type="button"
          className="grid h-7 w-7 place-items-center text-ink-faint hover:text-danger"
          onClick={() => patchTemplateData((d) => { d.pipelines = d.pipelines.filter((x) => x.id !== pipeline.id); })}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <Select
        value={pipeline.sourceId}
        onChange={(e) => patchTemplateData((d) => {
          const p = d.pipelines.find((x) => x.id === pipeline.id);
          if (p) p.sourceId = e.target.value;
        })}
      >
        <option value="">— source —</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>{s.label || s.id}</option>
        ))}
      </Select>

      <div className="space-y-1">
        <span className="text-[11px] text-ink-muted">Select (designer-only)</span>
        <Select value={pipeline.select.mode} onChange={(e) => setSelect(e.target.value as DataSelect['mode'])}>
          <option value="first">first</option>
          <option value="last">last</option>
          <option value="index">index</option>
          <option value="byKey">byKey</option>
          <option value="match">match</option>
          <option value="all">all</option>
        </Select>
        {pipeline.select.mode === 'index' && (
          <NumberInput
            value={pipeline.select.index}
            min={1}
            onChange={(n) => patchTemplateData((d) => {
              const p = d.pipelines.find((x) => x.id === pipeline.id);
              if (p) p.select = { mode: 'index', index: Math.max(1, Math.round(n)) };
            })}
          />
        )}
        {pipeline.select.mode === 'byKey' && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={pipeline.select.key}
              placeholder="key"
              onChange={(e) => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p?.select.mode === 'byKey') p.select = { ...p.select, key: e.target.value };
              })}
            />
            <Input
              value={pipeline.select.value}
              placeholder="value"
              onChange={(e) => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p?.select.mode === 'byKey') p.select = { ...p.select, value: e.target.value };
              })}
            />
          </div>
        )}
        {pipeline.select.mode === 'match' && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={pipeline.select.key}
              placeholder="key"
              onChange={(e) => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p?.select.mode === 'match') p.select = { ...p.select, key: e.target.value };
              })}
            />
            <Input
              value={pipeline.select.pattern}
              placeholder="regex"
              onChange={(e) => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p?.select.mode === 'match') p.select = { ...p.select, pattern: e.target.value };
              })}
            />
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-ink-muted">Map → variables</span>
          <button
            type="button"
            className="text-[11px] text-primary hover:underline"
            onClick={() => patchTemplateData((d) => {
              const p = d.pipelines.find((x) => x.id === pipeline.id);
              if (!p) return;
              p.map.push({
                from: 'name',
                to: { type: 'variable', variableId: variables[0]?.id ?? '' },
                as: 'text',
              });
            })}
          >
            + map
          </button>
        </div>
        {pipeline.map.map((entry, idx) => (
          <div key={idx} className={cn('grid grid-cols-[1fr_1fr_auto_auto] items-center gap-1')}>
            <Input
              value={entry.from}
              placeholder="from"
              onChange={(e) => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p?.map[idx]) p.map[idx]!.from = e.target.value;
              })}
            />
            <Select
              value={entry.to.variableId}
              onChange={(e) => {
                const variableId = e.target.value;
                patchTemplateData((d) => {
                  const p = d.pipelines.find((x) => x.id === pipeline.id);
                  if (p?.map[idx]) p.map[idx]!.to = { type: 'variable', variableId };
                });
                if (variableId) {
                  updateVariable(variableId, { drivenBy: pipeline.id, exposed: false });
                }
              }}
            >
              <option value="">— var —</option>
              {variables.map((v) => (
                <option key={v.id} value={v.id}>{v.label || v.name}</option>
              ))}
            </Select>
            <Select
              value={entry.as ?? 'text'}
              onChange={(e) => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p?.map[idx]) p.map[idx]!.as = e.target.value as DataMapAs;
              })}
            >
              <option value="text">text</option>
              <option value="multitext">multitext</option>
              <option value="number">number</option>
              <option value="image">image</option>
              <option value="video">video</option>
            </Select>
            <button
              type="button"
              className="grid h-7 w-7 place-items-center text-ink-faint hover:text-danger"
              onClick={() => patchTemplateData((d) => {
                const p = d.pipelines.find((x) => x.id === pipeline.id);
                if (p) p.map.splice(idx, 1);
              })}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
