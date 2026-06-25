import { Link } from 'react-router-dom';
import { Placeholder } from '@/components/Placeholder';

export function NotFoundPage() {
  return (
    <Placeholder title="Not found">
      That page doesn&rsquo;t exist.{' '}
      <Link to="/templates" className="text-primary hover:underline">
        Back to templates
      </Link>
    </Placeholder>
  );
}
