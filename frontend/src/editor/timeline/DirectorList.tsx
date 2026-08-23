import type { TimelineDirector } from '@runtime';
import { cn } from '@/lib/cn';
import { parseTimelineDrag } from './layout';

export function DirectorList({
  directors,
  activeId,
  onSelect,
  onDropPayload,
}: {
  directors: TimelineDirector[];
  activeId: string;
  onSelect: (id: string) => void;
  onDropPayload: (directorId: string, data: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {directors.map((director) => {
        const active = director.id === activeId;
        return (
          <button
            key={director.id}
            type="button"
            onClick={() => onSelect(director.id)}
            onDragOver={(event) => { event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              const data = event.dataTransfer.getData('text/plain');
              if (parseTimelineDrag(data)) onDropPayload(director.id, data);
            }}
            className={cn(
              'shrink-0 rounded-md px-2 py-1 text-[11px]',
              active ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2',
            )}
            title={director.name}
          >
            {director.name}
          </button>
        );
      })}
    </div>
  );
}
