import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  LayoutTemplate,
  SlidersHorizontal,
  Settings,
  MonitorPlay,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AuthUser } from '@/core/api';
import {
  readBooleanPreference,
  type StorageLike,
  writeBooleanPreference,
} from '@/ui/chromePrefs';
import { WsStatus } from './WsStatus';
import { Toaster } from './Toaster';

const NAV_COLLAPSED_KEY = 'titulus.shell.navCollapsed';

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const storage = safeStorage();
    return storage ? readBooleanPreference(storage, NAV_COLLAPSED_KEY, false) : false;
  });

  const toggleNavigation = () => {
    const nextCollapsed = !navCollapsed;
    setNavCollapsed(nextCollapsed);

    const storage = safeStorage();
    if (storage) writeBooleanPreference(storage, NAV_COLLAPSED_KEY, nextCollapsed);
  };

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-surface-2 transition-[width] duration-200 motion-reduce:transition-none',
          navCollapsed ? 'w-14' : 'w-56',
        )}
      >
        <div
          className={cn(
            'flex h-14 items-center gap-2.5 border-b border-border',
            navCollapsed ? 'justify-center px-2' : 'px-4',
          )}
        >
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary font-bold text-primary-ink"
            aria-label="Titulus"
            title="Titulus"
          >
            T
          </span>
          {!navCollapsed && <span className="font-semibold tracking-tight">Titulus</span>}
        </div>

        <div className="p-2 pb-0">
          <button
            type="button"
            onClick={toggleNavigation}
            aria-expanded={!navCollapsed}
            aria-controls="app-navigation"
            aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={cn(
              'flex h-8 items-center rounded-md text-ink-muted transition-colors hover:bg-surface hover:text-ink',
              navCollapsed ? 'w-full justify-center' : 'w-full justify-end px-2',
            )}
          >
            {navCollapsed ? (
              <ChevronRight className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronLeft className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>

        <nav id="app-navigation" className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              aria-label={navCollapsed ? label : undefined}
              title={navCollapsed ? label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex items-center rounded-md py-2 text-sm transition-colors',
                  navCollapsed ? 'justify-center px-2' : 'gap-3 px-3',
                  isActive
                    ? 'bg-primary/15 text-ink'
                    : 'text-ink-muted hover:bg-surface hover:text-ink',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {!navCollapsed && label}
            </NavLink>
          ))}
        </nav>

        <a
          href="/renderer"
          target="_blank"
          rel="noreferrer"
          aria-label={navCollapsed ? 'Open renderer' : undefined}
          title={navCollapsed ? 'Open renderer' : undefined}
          className={cn(
            'm-2 flex items-center rounded-md py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface hover:text-ink',
            navCollapsed ? 'justify-center px-2' : 'gap-2 px-3',
          )}
        >
          <MonitorPlay className="h-4 w-4 shrink-0" aria-hidden />
          {!navCollapsed && 'Open renderer'}
        </a>
        <div
          className={cn(
            'mx-2 mb-2 rounded-md border border-border bg-surface text-[12px] text-ink-muted',
            navCollapsed ? 'flex flex-col items-center gap-1.5 px-1 py-2' : 'px-3 py-2',
          )}
          title={navCollapsed ? `${user.username} (${user.role})` : undefined}
        >
          {navCollapsed ? (
            <div
              className="grid h-6 w-6 place-items-center rounded-full bg-surface-2 font-medium text-ink"
              aria-label={`${user.username}, ${user.role}`}
            >
              {user.username.slice(0, 1).toUpperCase() || '?'}
            </div>
          ) : (
            <>
              <div className="truncate font-medium text-ink">{user.username}</div>
              <div className="mt-0.5 tnum text-[11px] uppercase tracking-wide">{user.role}</div>
            </>
          )}
          <button
            type="button"
            onClick={onLogout}
            aria-label={navCollapsed ? 'Logout' : undefined}
            title={navCollapsed ? 'Logout' : undefined}
            className={cn(
              'flex items-center text-[12px] text-ink-muted hover:text-ink',
              navCollapsed ? 'justify-center p-1' : 'mt-2 gap-1.5',
            )}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            {!navCollapsed && 'Logout'}
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
