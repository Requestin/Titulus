export const id = '006_rbac_groups';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_groups (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS user_group_members (
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    );
  `);
  const groups = ['template_editor', 'control', 'settings', 'files.read'];
  const insert = db.prepare('INSERT OR IGNORE INTO permission_groups (id) VALUES (?)');
  for (const group of groups) insert.run(group);
  const users = db.prepare('SELECT id, role FROM users').all();
  const member = db.prepare('INSERT OR IGNORE INTO user_group_members (user_id, group_id) VALUES (?, ?)');
  for (const user of users) {
    const assigned = user.role === 'admin' ? groups : ['control', 'files.read'];
    for (const group of assigned) member.run(user.id, group);
  }
}
