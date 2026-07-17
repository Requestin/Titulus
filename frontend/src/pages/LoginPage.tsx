import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/form';

export function LoginPage({
  onLogin,
}: {
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onLogin(username.trim(), password);
      setPassword('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'login failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <div className="relative w-full max-w-sm">
        <img
          src="/titulus-logo.png"
          alt="Titulus"
          width={1680}
          height={1680}
          className="pointer-events-none absolute bottom-full left-1/2 mb-5 h-auto w-[min(1680px,90vw)] -translate-x-1/2 select-none"
          draggable={false}
        />
        <form onSubmit={submit} className="w-full space-y-4 rounded-xl border border-border bg-surface p-5">
          <div>
            <h1 className="text-base font-semibold">Sign in</h1>
          </div>
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error ? <div className="text-[12px] text-danger">{error}</div> : null}
          <Button type="submit" variant="primary" className="w-full" disabled={busy || !username || !password}>
            {busy ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
