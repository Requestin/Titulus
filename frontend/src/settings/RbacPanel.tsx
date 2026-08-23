import { useEffect, useState } from 'react';
import { api, type AuthUser, type PermissionGroup } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';

const GROUPS: PermissionGroup[] = ['template_editor', 'control', 'settings', 'files.read'];

export function RbacPanel() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [groupsByUser, setGroupsByUser] = useState<Record<string, string[]>>({});
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function load() {
    try {
      const list = await api.auth.listUsers();
      setUsers(list);
      const next: Record<string, string[]> = {};
      for (const user of list) {
        next[user.id] = await api.auth.userGroups(user.id);
      }
      setGroupsByUser(next);
    } catch (error) {
      toast.error(`Failed to load users: ${(error as Error).message}`);
    }
  }

  useEffect(() => { void load(); }, []);

  async function create() {
    try {
      await api.auth.createUser({ username, password, role: 'operator' });
      setUsername('');
      setPassword('');
      await load();
    } catch (error) {
      toast.error(`Create user failed: ${(error as Error).message}`);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <h4 className="text-sm font-semibold">Users and permissions</h4>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Username">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button size="sm" onClick={() => void create()}>Add operator</Button>
        </div>
      </div>
      <ul className="space-y-2">
        {users.map((user) => (
          <li key={user.id} className="rounded-md border border-border bg-surface-2 p-3 text-[12px]">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{user.username}</span>
              <Select
                value={user.role}
                onChange={(event) => {
                  void api.auth.updateUser(user.id, { role: event.target.value as AuthUser['role'] })
                    .then(() => load())
                    .catch((error) => toast.error((error as Error).message));
                }}
              >
                <option value="operator">operator</option>
                <option value="admin">admin</option>
              </Select>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={user.isActive}
                  onChange={(event) => {
                    void api.auth.updateUser(user.id, { isActive: event.target.checked })
                      .then(() => load())
                      .catch((error) => toast.error((error as Error).message));
                  }}
                />
                active
              </label>
            </div>
            <div className="flex flex-wrap gap-3">
              {GROUPS.map((group) => {
                const checked = user.role === 'admin' || (groupsByUser[user.id] ?? []).includes(group);
                return (
                  <label key={group} className="flex items-center gap-1 text-ink-muted">
                    <input
                      type="checkbox"
                      disabled={user.role === 'admin'}
                      checked={checked}
                      onChange={(event) => {
                        const current = new Set(groupsByUser[user.id] ?? []);
                        if (event.target.checked) current.add(group);
                        else current.delete(group);
                        void api.auth.setUserGroups(user.id, [...current] as import('@/core/api').PermissionGroup[])
                          .then(() => load())
                          .catch((error) => toast.error((error as Error).message));
                      }}
                    />
                    {group}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
