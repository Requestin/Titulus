import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutTemplate, SlidersHorizontal, Settings, LogOut, Box, PanelLeftClose, PanelLeft,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AuthUser } from '@/core/api';
import { WsStatus } from './WsStatus';
import { Toaster } from './Toaster';

const NAV = [
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/ue-templates', label: 'UE Templates', icon: Box },
  { to: '/control', label: 'Control', icon: SlidersHorizontal },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

const NAV_COLLAPSED_KEY = (userId: string) => `titulus.nav.collapsed.${userId}`;

function pageTitle(pathname: string): string {
  if (pathname.startsWith('/editor')) return 'Editor';
  if (pathname.startsWith('/ue-templates')) return 'UE Templates';
  if (pathname.startsWith('/control')) return 'Control';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Templates';
}

export function AppShell({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY(user.id)) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY(user.id), collapsed ? '1' : '0');
    } catch {
      /* ignore quota */
    }
  }, [collapsed, user.id]);

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-surface-2 transition-[width] duration-200 ease-out',
          collapsed ? 'w-14' : 'w-56',
        )}
      >
        <div className={cn(
          'flex h-14 items-center border-b border-border',
          collapsed ? 'justify-center px-1' : 'gap-2.5 px-3',
        )}
        >
          {!collapsed && (
            <>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary font-bold text-primary-ink">
                T
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">Titulus</span>
            </>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-surface hover:text-ink"
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!collapsed}
          >
            {collapsed
              ? <PanelLeft className="h-4 w-4" aria-hidden />
              : <PanelLeftClose className="h-4 w-4" aria-hidden />}
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) =>
                cn(
                  'flex items-center rounded-md py-2 text-sm transition-colors',
                  collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                  isActive
                    ? 'bg-primary/15 text-ink'
                    : 'text-ink-muted hover:bg-surface hover:text-ink',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>

        <div className={cn(
          'mx-2 mb-2 rounded-md border border-border bg-surface text-ink-muted',
          collapsed ? 'px-1 py-2' : 'px-3 py-2 text-[12px]',
        )}
        >
          {!collapsed && (
            <>
              <div className="truncate font-medium text-ink">{user.username}</div>
              <div className="mt-0.5 tnum text-[11px] uppercase tracking-wide">{user.role}</div>
            </>
          )}
          <button
            onClick={onLogout}
            title="Logout"
            className={cn(
              'flex items-center text-[12px] text-ink-muted hover:text-ink',
              collapsed ? 'mx-auto justify-center' : 'mt-2 gap-1.5',
            )}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            {!collapsed && 'Logout'}
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
