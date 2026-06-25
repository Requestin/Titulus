import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Loader2, LayoutTemplate } from 'lucide-react';
import { createDefaultTemplate } from '@runtime';
import { api, type TemplateSummary } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { toast } from '@/core/toast';

export function TemplatesPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<TemplateSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.templates.list());
    } catch (e) {
      toast.error(`Failed to load templates: ${(e as Error).message}`);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    try {
      const rec = await api.templates.create('Untitled template', createDefaultTemplate());
      nav(`/editor/${rec.id}`);
    } catch (e) {
      toast.error(`Create failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await api.templates.remove(id);
      setItems((cur) => (cur ?? []).filter((t) => t.id !== id));
      toast.success('Template deleted');
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="text-[13px] text-ink-muted">
            Design title graphics. The editor preview is the on-air render.
          </p>
        </div>
        <Button variant="primary" onClick={create} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          New template
        </Button>
      </div>

      {items === null ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[164px] animate-pulse rounded-lg border border-border bg-surface" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface/40 px-6 py-16 text-center">
          <LayoutTemplate className="h-8 w-8 text-ink-faint" aria-hidden />
          <div>
            <p className="text-sm font-medium">No templates yet</p>
            <p className="text-[13px] text-ink-muted">Create your first title graphic to start.</p>
          </div>
          <Button variant="primary" onClick={create} disabled={creating}>
            <Plus className="h-4 w-4" aria-hidden />
            New template
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {items.map((t) => (
            <div
              key={t.id}
              className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-ink-faint"
            >
              <button
                onClick={() => nav(`/editor/${t.id}`)}
                className="grid aspect-video place-items-center bg-surface-2 text-ink-faint"
                aria-label={`Open ${t.name}`}
              >
                <LayoutTemplate className="h-7 w-7" aria-hidden />
              </button>
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <button onClick={() => nav(`/editor/${t.id}`)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="truncate text-xs text-ink-faint">Updated {t.updated_at}</div>
                </button>
                <button
                  onClick={() => remove(t.id, t.name)}
                  aria-label={`Delete ${t.name}`}
                  className="text-ink-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
