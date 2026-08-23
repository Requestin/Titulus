import type { TimelineCue, TimelineCueCommand, TimelineCueItem, TimelineDirector } from '@runtime';
import { Field, Input, NumberInput, Select, Checkbox } from '@/components/ui/form';
import {
  CUE_DIRECTIONS,
  constrainCueTag,
  createCueItem,
  cueFrameFromEffective,
  effectiveCueFrame,
  isProtectedUpdateDirector,
} from '../timelineCues';

const COMMANDS: TimelineCueCommand[] = [
  'startDirector',
  'stopDirector',
  'stopDirectorAndWaitContinue',
  'pauseDirector',
  'tag',
];

export function CueInspector({
  cue,
  directors,
  onUpdateCue,
  onUpdateItem,
  onAddItem,
}: {
  cue: TimelineCue;
  directors: TimelineDirector[];
  onUpdateCue: (partial: Partial<Pick<TimelineCue, 'name' | 'fromEnd' | 'frame'>>) => void;
  onUpdateItem: (itemId: string, item: TimelineCueItem) => void;
  onAddItem: () => void;
}) {
  const host = directors.find((item) => item.id === cue.directorId);
  const duration = host?.durationFrames ?? 0;
  const visual = effectiveCueFrame(cue, duration);

  return (
    <div className="space-y-3 p-3">
      <Field label="Action">
        <Input value={cue.name} onChange={(event) => onUpdateCue({ name: event.target.value })} />
      </Field>
      <Field label="Frame">
        <NumberInput
          value={visual}
          min={0}
          max={duration}
          step={1}
          onChange={(value) => onUpdateCue({
            frame: cueFrameFromEffective(value, cue.fromEnd, duration),
          })}
        />
      </Field>
      <Checkbox
        label="from end"
        checked={cue.fromEnd}
        onChange={(fromEnd) => onUpdateCue({
          fromEnd,
          frame: cueFrameFromEffective(visual, fromEnd, duration),
        })}
      />
      <div className="space-y-2">
        {cue.items.map((item, index) => (
          <div key={item.id} className="rounded-md border border-border p-2">
            <Field label={`Item ${index + 1}`}>
              <Select
                value={item.command}
                onChange={(event) => {
                  const command = event.target.value as TimelineCueCommand;
                  const next = command === item.command
                    ? item
                    : createCueItem(command, item.command === 'tag' ? cue.directorId : item.parameterDirectorId);
                  onUpdateItem(item.id, constrainCueTag(next, host ?? { name: '' }, [], cue.id));
                }}
              >
                {COMMANDS.map((command) => (
                  <option key={command} value={command}>{command}</option>
                ))}
              </Select>
            </Field>
            {item.command === 'tag' ? (
              <Field label="Tag">
                <Select
                  value={item.parameterTag}
                  disabled={isProtectedUpdateDirector(host)}
                  onChange={(event) => onUpdateItem(item.id, constrainCueTag(
                    { ...item, parameterTag: event.target.value as 'endScene' | 'updateData' },
                    host ?? { name: '' },
                    [],
                    cue.id,
                  ))}
                >
                  <option value="endScene">endScene</option>
                  <option value="updateData">updateData</option>
                </Select>
              </Field>
            ) : (
              <>
                <Field label="Director">
                  <Select
                    value={item.parameterDirectorId}
                    onChange={(event) => onUpdateItem(item.id, {
                      ...item,
                      parameterDirectorId: event.target.value,
                    })}
                  >
                    {directors.map((director) => (
                      <option key={director.id} value={director.id}>{director.name}</option>
                    ))}
                  </Select>
                </Field>
                {item.command === 'pauseDirector' && (
                  <Field label="Pause frames">
                    <NumberInput
                      value={item.lengthFrames}
                      min={0}
                      step={1}
                      onChange={(value) => onUpdateItem(item.id, {
                        ...item,
                        lengthFrames: Math.max(0, Math.round(value)),
                      })}
                    />
                  </Field>
                )}
              </>
            )}
            <Field label="Direction">
              <Select
                value={item.direction}
                onChange={(event) => onUpdateItem(item.id, {
                  ...item,
                  direction: event.target.value as TimelineCueItem['direction'],
                })}
              >
                {CUE_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>{direction}</option>
                ))}
              </Select>
            </Field>
          </div>
        ))}
        <button
          type="button"
          onClick={onAddItem}
          className="rounded-md border border-dashed border-border px-2 py-1 text-[12px] text-ink-muted hover:text-ink"
        >
          Add item
        </button>
      </div>
    </div>
  );
}
