import { useParams } from 'react-router-dom';
import { Placeholder } from '@/components/Placeholder';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Placeholder title="Template editor">
      Editor for <span className="font-mono text-ink">{id}</span> lands in task 2.6 (canvas, layers,
      properties, variables, timeline).
    </Placeholder>
  );
}
