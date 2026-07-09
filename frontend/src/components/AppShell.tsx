import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutTemplate, SlidersHorizontal, Settings, LogOut } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AuthUser } from '@/core/api';
import { WsStatus } from './WsStatus';
import { Toaster } from './Toaster';

const NAV = [
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/control', label: 'Control', icon: SlidersHorizontal },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

function pageTitle(pathname: string): string {
  if (pathname.startsWith('/editor')) return 'Editor';
  if (pathname.startsWith('/control')) return 'Control';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Templates';
}

export function AppShell({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const { pathname } = useLocation();

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface-2">
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary font-bold text-primary-ink">
            T
          </span>
          <span className="font-semibold tracking-tight">Titulus</span>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-primary/15 text-ink'
                    : 'text-ink-muted hover:bg-surface hover:text-ink',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mx-2 mb-2 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-muted">
          <div className="truncate font-medium text-ink">{user.username}</div>
          <div className="mt-0.5 tnum text-[11px] uppercase tracking-wide">{user.role}</div>
          <button
            onClick={onLogout}
            className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-muted hover:text-ink"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            Logout
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <h1 className="text-sm font-semibold">{pageTitle(pathname)}</h1>
          <WsStatus />
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      <Toaster />
    </div>
  );
}
