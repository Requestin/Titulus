// frontend/src/editor/CrawlProperties.tsx
// Content + Crawl inspector sections for crawl layers.

import { useState } from 'react';
import type {
  CrawlAnimationType,
  CrawlAxisDir,
  CrawlKind,
  CrawlLayer,
  CrawlSeparatorMode,
  Layer,
  Variable,
  VariableBinding,
} from '@runtime';
import { PropertyField, Section, Input, NumberInput, Select, Checkbox } from '@/components/ui/form';
import { Button } from '@/components/ui/Button';
import { MediaSourcePicker } from './media/MediaSourcePicker';
import { recomputeCrawlDirectorDuration } from './crawlTimeline';
import { useEditor } from './store';
import { crawlFileErrorMessage, readCrawlTextFile } from '@/core/crawlFile';
import { cn } from '@/lib/cn';
import { Braces } from 'lucide-react';

type UpdateLayer = (id: string, mutator: (l: Layer) => void) => void;

const CRAWL_BIND_TYPES = new Set(['multitext', 'textfile', 'text']);

export function CrawlTypeSections({
  layer,
  variables,
}: {
  layer: CrawlLayer;
  variables: Variable[];
  updateLayer: UpdateLayer;
}) {
  const patch = useEditor((s) => s.patch);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const crawl = layer.crawl;
  const useFile = crawl.useFile;
  const bindVars = variables.filter((v) => CRAWL_BIND_TYPES.has(v.type));
  const isBound = typeof layer.content === 'object' && layer.content !== null;
  const contentStr = typeof layer.content === 'string' ? layer.content : '';

  function mutateCrawl(mutator: (c: CrawlLayer['crawl']) => void) {
    patch((t) => {
      const l = t.layers.find((x) => x.id === layer.id);
      if (!l || l.type !== 'crawl') return;
      mutator(l.crawl);
      recomputeCrawlDirectorDuration(t, l);
    });
  }

  function setContent(v: string | VariableBinding) {
    patch((t) => {
      const l = t.layers.find((x) => x.id === layer.id);
      if (!l || l.type !== 'crawl') return;
      l.content = v;
      recomputeCrawlDirectorDuration(t, l);
    });
  }

  async function onParse() {
    setParseError('');
    setParsing(true);
    try {
      const text = await readCrawlTextFile(crawl.filePath);
      setContent(text);
    } catch (err) {
      setParseError(crawlFileErrorMessage(err));
    } finally {
      setParsing(false);
    }
  }

  const dirOptions: CrawlAxisDir[] = crawl.type === 'ticker' ? ['left', 'right'] : ['up', 'down'];

  return (
    <>
      <Section title="Content">
        <div className="flex items-start gap-1.5">
          {isBound ? (
            <Select
              className="flex-1"
              value={(layer.content as VariableBinding).variableId}
              disabled={useFile}
              onChange={(e) => setContent({ type: 'variable', variableId: e.target.value })}
            >
              {bindVars.length === 0 && <option value="">No variables</option>}
              {bindVars.map((v) => (
                <option key={v.id} value={v.id}>{v.label || v.name}</option>
              ))}
            </Select>
          ) : (
            <textarea
              value={contentStr}
              readOnly={useFile}
              onChange={(e) => setContent(e.target.value)}
              className={cn(
                'min-h-[72px] w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-ink whitespace-pre',
                'placeholder:text-ink-faint focus-visible:outline-none focus-visible:border-ring',
                useFile && 'opacity-70',
              )}
              spellCheck={false}
            />
          )}
          <button
            type="button"
            title={isBound ? 'Unbind variable' : 'Bind to variable'}
            disabled={useFile || (!isBound && bindVars.length === 0)}
            onClick={() => {
              if (isBound) setContent('');
              else if (bindVars[0]) setContent({ type: 'variable', variableId: bindVars[0].id });
            }}
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border',
              isBound && !useFile ? 'border-primary text-primary' : 'text-ink-faint hover:text-ink disabled:opacity-40',
            )}
          >
            <Braces className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        <button
          type="button"
          aria-pressed={useFile}
          onClick={() => {
            const next = !useFile;
            patch((t) => {
              const l = t.layers.find((x) => x.id === layer.id);
              if (!l || l.type !== 'crawl') return;
              l.crawl.useFile = next;
              if (next && typeof l.content === 'object') l.content = '';
              recomputeCrawlDirectorDuration(t, l);
            });
          }}
          className={cn(
            'h-8 w-full rounded-md border text-[12px] font-semibold',
            useFile ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-surface-2 text-ink-muted',
          )}
        >
          Use File
        </button>

        <PropertyField label="Filepath">
          <Input
            value={crawl.filePath}
            disabled={!useFile}
            placeholder="/path/to/file.txt"
            onChange={(e) => mutateCrawl((c) => { c.filePath = e.target.value; })}
          />
        </PropertyField>
        <Button
          type="button"
          className="w-full"
          disabled={!useFile || parsing}
          onClick={() => void onParse()}
        >
          {parsing ? 'Parsing…' : 'Parse'}
        </Button>
        {parseError ? <div className="text-[12px] text-danger">{parseError}</div> : null}

        <Checkbox
          label="Maximum text length"
          checked={crawl.maxTextLengthEnabled}
          onChange={(v) => mutateCrawl((c) => { c.maxTextLengthEnabled = v; })}
        />
        <Labeled disabled={!crawl.maxTextLengthEnabled}>
          <PropertyField label="Max chars">
            <NumberInput
              value={crawl.maxTextLength}
              disabled={!crawl.maxTextLengthEnabled}
              resetValue={80}
              onChange={(v) => mutateCrawl((c) => { c.maxTextLength = Math.max(1, Math.floor(v)); })}
            />
          </PropertyField>
        </Labeled>
      </Section>

      <Section title="Crawl">
        <PropertyField label="Type">
          <Select
            value={crawl.type}
            onChange={(e) => {
              const type = e.target.value as CrawlKind;
              mutateCrawl((c) => {
                c.type = type;
                if (type === 'ticker') {
                  c.directionIn = 'right';
                  c.directionOut = 'left';
                } else {
                  c.directionIn = 'up';
                  c.directionOut = 'down';
                }
              });
            }}
          >
            <option value="carousel">Carousel</option>
            <option value="ticker">Ticker</option>
          </Select>
        </PropertyField>
        <PropertyField label="In">
          <Select
            value={crawl.directionIn}
            onChange={(e) => mutateCrawl((c) => { c.directionIn = e.target.value as CrawlAxisDir; })}
          >
            {dirOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </PropertyField>
        <PropertyField label="Out">
          <Select
            value={crawl.directionOut}
            onChange={(e) => mutateCrawl((c) => { c.directionOut = e.target.value as CrawlAxisDir; })}
          >
            {dirOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </PropertyField>
        <PropertyField label="Speed">
          <NumberInput
            value={crawl.speed}
            resetValue={5}
            step={0.5}
            onChange={(v) => mutateCrawl((c) => { c.speed = Math.max(0.1, v); })}
          />
        </PropertyField>
        <PropertyField label="Pause(frame)">
          <NumberInput
            value={crawl.pause}
            resetValue={0}
            step={1}
            onChange={(v) => mutateCrawl((c) => { c.pause = Math.max(0, Math.round(v)); })}
          />
        </PropertyField>

        <div className="space-y-1.5">
          <div className="text-[12px] text-ink-muted">Separator</div>
          <div className="flex gap-1" role="radiogroup" aria-label="Separator">
            {([
              { mode: 'none' as const, label: 'X' },
              { mode: 'text' as const, label: 'Text' },
              { mode: 'image' as const, label: 'Image' },
            ]).map((opt) => {
              const active = crawl.separatorMode === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => mutateCrawl((c) => { c.separatorMode = opt.mode as CrawlSeparatorMode; })}
                  className={cn(
                    'h-8 min-w-0 flex-1 rounded-md border text-[12px] font-semibold',
                    active ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-surface-2 text-ink-muted',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        {crawl.separatorMode === 'text' && (
          <PropertyField label="Sep text">
            <Input
              value={crawl.separatorText}
              onChange={(e) => mutateCrawl((c) => { c.separatorText = e.target.value; })}
            />
          </PropertyField>
        )}
        {crawl.separatorMode === 'image' && (
          <MediaSourcePicker
            type="image"
            src={crawl.separatorImage}
            onSelect={(asset) => mutateCrawl((c) => { c.separatorImage = asset.url; })}
          />
        )}

        <PropertyField label="Anim">
          <Select
            value={crawl.animationType}
            onChange={(e) => mutateCrawl((c) => {
              c.animationType = e.target.value as CrawlAnimationType;
            })}
          >
            <option value="batch">Batch</option>
            <option value="continuous">Continuous</option>
          </Select>
        </PropertyField>
      </Section>
    </>
  );
}

function Labeled({ disabled, children }: { disabled?: boolean; children: React.ReactNode }) {
  return <div className={cn(disabled && 'opacity-40')}>{children}</div>;
}
