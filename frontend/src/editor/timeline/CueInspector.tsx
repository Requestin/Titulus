import type {
  TimelineCue,
  TimelineCueCommand,
  TimelineCueDirection,
  TimelineCueItem,
  TimelineCueTag,
  TimelineDirector,
} from '@runtime';
import { Field, Input, NumberInput, Select } from '@/components/ui/form';
import { cn } from '@/lib/cn';
import {
  constrainCueTag,
  createCueItem,
  isProtectedUpdateDirector,
} from '../timelineCues';

const COMMANDS: Array<{ value: TimelineCueCommand; label: string }> = [
  { value: '', label: '' },
  { value: 'startDirector', label: 'Start director' },
  { value: 'stopDirector', label: 'Stop director' },
  { value: 'stopDirectorAndWaitContinue', label: 'Stop director and wait continue' },
  { value: 'pauseDirector', label: 'Pause director' },
  { value: 'tag', label: 'Tag' },
];

const TAGS: Array<{ value: TimelineCueTag; label: string }> = [
  { value: 'endScene', label: 'End scene' },
  { value: 'updateData', label: 'Update data' },
  { value: 'previewFrame', label: 'Preview frame' },
];

const DIRECTION_BUTTONS: Array<{ value: TimelineCueDirection; label: string }> = [
  { value: 'both', label: 'Both' },
  { value: 'normal', label: 'Normal' },
  { value: 'reverse', label: 'Reverse' },
];

function itemFromCommand(
  command: TimelineCueCommand,
  hostDirectorId: string,
  previous: TimelineCueItem,
): TimelineCueItem {
  if (command === previous.command) return previous;
  const next = createCueItem(
    command,
    command === 'startDirector' ? '' : hostDirectorId,
  );
  return next;
}

export function CueInspector({
  cue,
  directors,
  onUpdateCue,
  onUpdateItem,
  onAddItem,
  onRemoveItem,
}: {
  cue: TimelineCue;
  directors: TimelineDirector[];
  onUpdateCue: (partial: Partial<Pick<TimelineCue, 'name' | 'fromEnd' | 'frame'>>) => void;
  onUpdateItem: (itemId: string, item: TimelineCueItem) => void;
  onAddItem: () => void;
  onRemoveItem: (itemId: string) => void;
}) {
  const host = directors.find((item) => item.id === cue.directorId);
  const multiple = cue.items.length > 1;

  return (
    <div className="space-y-3 p-3">
      <Field label="Name">
        <Input
          value={cue.name}
          placeholder="Optional"
          onChange={(event) => onUpdateCue({ name: event.target.value })}
        />
      </Field>
      {cue.items.map((item) => (
        <div key={item.id} className="space-y-2 rounded-md border border-border p-2.5">
          <Field label="Command">
            <Select
              value={item.command}
              onChange={(event) => {
                const command = event.target.value as TimelineCueCommand;
                onUpdateItem(
                  item.id,
                  constrainCueTag(itemFromCommand(command, cue.directorId, item), host ?? { name: '' }, [], cue.id),
                );
              }}
            >
              {COMMANDS.map((command) => (
                <option key={command.value || 'none'} value={command.value}>{command.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Parameter">
            {item.command === '' ? (
              <Select value="" disabled>
                <option value="" />
              </Select>
            ) : item.command === 'tag' ? (
              <Select
                value={item.parameterTag}
                disabled={isProtectedUpdateDirector(host)}
                onChange={(event) => onUpdateItem(item.id, constrainCueTag(
                  { ...item, parameterTag: event.target.value as TimelineCueTag },
                  host ?? { name: '' },
                  [],
                  cue.id,
                ))}
              >
                {TAGS.map((tag) => (
                  <option key={tag.value} value={tag.value}>{tag.label}</option>
                ))}
              </Select>
            ) : (
              <Select
                value={item.parameterDirectorId}
                onChange={(event) => onUpdateItem(item.id, {
                  ...item,
                  parameterDirectorId: event.target.value,
                })}
              >
                {item.command === 'startDirector' && <option value="" />}
                {directors.map((director) => (
                  <option key={director.id} value={director.id}>{director.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Length">
            <NumberInput
              value={item.lengthFrames}
              min={0}
              step={1}
              stepper
              resetValue={0}
              disabled={item.command !== 'pauseDirector'}
              aria-label="Length"
              onChange={(value) => onUpdateItem(item.id, {
                ...item,
                lengthFrames: Math.max(0, Math.round(value)),
              })}
            />
          </Field>
          <Field label="Direction">
            <div className="flex rounded-md border border-border p-0.5">
              {DIRECTION_BUTTONS.map((direction) => (
                <button
                  key={direction.value}
                  type="button"
                  aria-pressed={item.direction === direction.value}
                  onClick={() => onUpdateItem(item.id, { ...item, direction: direction.value })}
                  className={cn(
                    'h-7 flex-1 rounded-[5px] px-1 text-[11px] font-medium',
                    item.direction === direction.value
                      ? 'bg-primary/20 text-ink'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {direction.label}
                </button>
              ))}
            </div>
          </Field>
          {multiple && (
            <button
              type="button"
              onClick={() => onRemoveItem(item.id)}
              className="rounded-md border border-border px-2 py-1 text-[12px] text-ink-muted hover:text-danger"
            >
              -Action
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={onAddItem}
        className="rounded-md border border-dashed border-border px-2 py-1 text-[12px] font-semibold text-ink-muted hover:text-ink"
        title="Add Action"
      >
        +
      </button>
    </div>
  );
}
