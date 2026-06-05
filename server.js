const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const net = require('net');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Security headers. frame-src allows same-host iframes (for the embedded ttyd
// terminals that run on different ports than Mission Control itself).
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'unsafe-inline'; " +
    "style-src 'unsafe-inline' 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-src 'self' http: https:; " +
    "frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Database
const db = new Database(path.join(__dirname, 'kanban.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📁',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS areas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📂',
    workspace_id TEXT DEFAULT '' REFERENCES workspaces(id) ON DELETE SET DEFAULT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#58a6ff',
    notes TEXT DEFAULT '',
    workspace_id TEXT DEFAULT '' REFERENCES workspaces(id) ON DELETE SET DEFAULT,
    area_id TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    type TEXT DEFAULT '',
    data TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    column_id TEXT DEFAULT 'todo',
    project_id TEXT DEFAULT '' REFERENCES projects(id) ON DELETE SET DEFAULT,
    urgent INTEGER DEFAULT 0,
    important INTEGER DEFAULT 1,
    due TEXT,
    tags TEXT DEFAULT '[]',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    type TEXT DEFAULT '',
    data TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
`);

// Migrations
try { db.exec(`ALTER TABLE projects ADD COLUMN priority INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN risk_flag INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE projects ADD COLUMN area_id TEXT DEFAULT ''`); } catch(e) {}

// Seed columns if empty
const colCount = db.prepare('SELECT COUNT(*) as c FROM columns').get().c;
if (colCount === 0) {
  const ins = db.prepare('INSERT INTO columns (id, title, sort_order) VALUES (?, ?, ?)');
  ins.run('backlog', '📋 Backlog', 0);
  ins.run('todo', '📌 To Do', 1);
  ins.run('in-progress', '🔧 In Progress', 2);
  ins.run('review', '👀 Review', 3);
  ins.run('done', '✅ Done', 4);
}

// Seed workspaces if empty
const wsCount = db.prepare('SELECT COUNT(*) as c FROM workspaces').get().c;
if (wsCount === 0) {
  const wins = db.prepare('INSERT INTO workspaces (id, name, icon, sort_order) VALUES (?, ?, ?, ?)');
  wins.run('k2', 'K2', '🏢', 0);
  wins.run('personal', 'Personal', '🏠', 1);
  // Assign existing projects to K2
  try { db.prepare("UPDATE projects SET workspace_id='k2'").run(); } catch(e) {}
}

// Seed projects if empty
const projCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
if (projCount === 0) {
  db.pragma('foreign_keys = OFF');
  const ins = db.prepare('INSERT INTO projects (id, name, color, workspace_id, sort_order) VALUES (?, ?, ?, ?, ?)');
  const wsExists = db.prepare("SELECT 1 FROM workspaces WHERE id='k2'").get();
  const wsId = wsExists ? 'k2' : '';
  ins.run('soc2', 'SOC 2', '#f85149', wsId, 0);
  ins.run('ai-adoption', 'Adopción IA', '#58a6ff', wsId, 1);
  ins.run('infra', 'Infraestructura', '#3fb950', wsId, 2);
  ins.run('general', 'General', '#8b949e', wsId, 3);

  // Seed tasks
  const tins = db.prepare('INSERT INTO tasks (id, title, description, column_id, project_id, urgent, important, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  tins.run('t1', 'Revisar informe SOC 2 Tipo I', '<p>Revisar resultado de auditoría enero 2025 y listar hallazgos</p>', 'todo', 'soc2', 1, 1, '["compliance"]');
  tins.run('t2', 'Definir política de uso de IA en K2', '<p>Clasificación de datos y herramientas de IA</p>', 'todo', 'ai-adoption', 1, 1, '["compliance"]');
  tins.run('t3', 'Plan de adopción de IA para equipo dev', '<p>Herramientas, workflows y plan de rollout</p>', 'backlog', 'ai-adoption', 0, 1, '["equipo"]');
  tins.run('t4', 'Configurar acceso Gmail para Mikey', '', 'backlog', 'infra', 0, 0, '["setup"]');
  tins.run('t5', 'Configurar Tailscale + SSH remoto', '', 'backlog', 'infra', 0, 0, '["setup"]');
  db.pragma('foreign_keys = ON');
}

// === API Routes ===

// Get all data
app.get('/api/data', (req, res) => {
  const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY sort_order').all();
  const areas = db.prepare('SELECT * FROM areas ORDER BY sort_order').all();
  const columns = db.prepare('SELECT * FROM columns ORDER BY sort_order').all();
  const projects = db.prepare('SELECT * FROM projects ORDER BY sort_order').all();
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, created_at').all();
  
  // Parse tags JSON
  tasks.forEach(t => { try { t.tags = JSON.parse(t.tags); } catch(e) { t.tags = []; } t.risk_flag = !!t.risk_flag; });
  
  // Load refs and files for projects (single query each, indexed by project_id)
  const allRefs = db.prepare('SELECT * FROM project_refs ORDER BY sort_order').all();
  const allPF = db.prepare('SELECT id, project_id, name, size, type, created_at FROM project_files ORDER BY created_at').all();
  const refsByProj = Object.groupBy ? Object.groupBy(allRefs, r => r.project_id) : allRefs.reduce((m, r) => { (m[r.project_id] = m[r.project_id] || []).push(r); return m; }, {});
  const filesByProj = Object.groupBy ? Object.groupBy(allPF, f => f.project_id) : allPF.reduce((m, f) => { (m[f.project_id] = m[f.project_id] || []).push(f); return m; }, {});
  projects.forEach(p => {
    p.refs = refsByProj[p.id] || [];
    p.files = filesByProj[p.id] || [];
  });

  // Load task files (metadata only, single query)
  const allTF = db.prepare('SELECT id, task_id, name, size, type, created_at FROM task_files ORDER BY created_at').all();
  const filesByTask = Object.groupBy ? Object.groupBy(allTF, f => f.task_id) : allTF.reduce((m, f) => { (m[f.task_id] = m[f.task_id] || []).push(f); return m; }, {});
  tasks.forEach(t => { t.files = filesByTask[t.id] || []; });

  res.json({ workspaces, areas, columns, projects, tasks });
});

// --- Workspaces ---
app.post('/api/workspaces', (req, res) => {
  const { id, name, icon } = req.body;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM workspaces').get().n;
  db.prepare('INSERT INTO workspaces (id, name, icon, sort_order) VALUES (?,?,?,?)').run(id, name, icon || '📁', sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/workspaces/:id', (req, res) => {
  const { name, icon, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (icon !== undefined) { sets.push('icon=?'); vals.push(icon); }
  if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE workspaces SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true }); broadcast('update');
});

app.delete('/api/workspaces/:id', (req, res) => {
  db.prepare("UPDATE areas SET workspace_id='' WHERE workspace_id=?").run(req.params.id);
  db.prepare("UPDATE projects SET workspace_id='' WHERE workspace_id=?").run(req.params.id);
  db.prepare('DELETE FROM workspaces WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Areas ---
app.post('/api/areas', (req, res) => {
  const { id, name, icon, workspace_id } = req.body;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM areas').get().n;
  db.prepare('INSERT INTO areas (id, name, icon, workspace_id, sort_order) VALUES (?,?,?,?,?)').run(id, name, icon || '📂', workspace_id || '', sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/areas/:id', (req, res) => {
  const { name, icon, workspace_id, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (icon !== undefined) { sets.push('icon=?'); vals.push(icon); }
  if (workspace_id !== undefined) { sets.push('workspace_id=?'); vals.push(workspace_id); }
  if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE areas SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true }); broadcast('update');
});

app.delete('/api/areas/:id', (req, res) => {
  db.prepare("UPDATE projects SET area_id='' WHERE area_id=?").run(req.params.id);
  db.prepare('DELETE FROM areas WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Projects ---
app.post('/api/projects', (req, res) => {
  const { id, name, color, workspace_id, area_id } = req.body;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM projects').get().n;
  db.prepare('INSERT INTO projects (id, name, color, workspace_id, area_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, color || '#58a6ff', workspace_id || null, area_id || '', sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/projects/:id', (req, res) => {
  const { name, color, notes, sort_order, workspace_id, area_id, priority } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (color !== undefined) { sets.push('color=?'); vals.push(color); }
  if (notes !== undefined) { sets.push('notes=?'); vals.push(notes); }
  if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
  if (workspace_id !== undefined) { sets.push('workspace_id=?'); vals.push(workspace_id); }
  if (area_id !== undefined) { sets.push('area_id=?'); vals.push(area_id); }
  if (priority !== undefined) { sets.push('priority=?'); vals.push(priority); }
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE projects SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  res.json({ ok: true }); broadcast('update');
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare("UPDATE tasks SET project_id='' WHERE project_id=?").run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Project refs ---
app.post('/api/projects/:id/refs', (req, res) => {
  const { title, url, notes } = req.body;
  const r = db.prepare('INSERT INTO project_refs (project_id, title, url, notes) VALUES (?,?,?,?)').run(req.params.id, title, url || '', notes || '');
  res.json({ ok: true, id: r.lastInsertRowid }); broadcast('update');
});

app.delete('/api/refs/:id', (req, res) => {
  db.prepare('DELETE FROM project_refs WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Project files ---
app.post('/api/projects/:id/files', (req, res) => {
  const { name, size, type, data } = req.body;
  const r = db.prepare('INSERT INTO project_files (project_id, name, size, type, data) VALUES (?,?,?,?,?)').run(req.params.id, name, size, type, data);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.get('/api/project-files/:id/download', (req, res) => {
  const f = db.prepare('SELECT * FROM project_files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  res.json({ name: f.name, type: f.type, data: f.data });
});

app.delete('/api/project-files/:id', (req, res) => {
  db.prepare('DELETE FROM project_files WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Tasks ---
app.post('/api/tasks', (req, res) => {
  const { id, title, description, column_id, project_id, urgent, important, due, tags } = req.body;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM tasks').get().n;
  db.prepare('INSERT INTO tasks (id, title, description, column_id, project_id, urgent, important, due, tags, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, title, description || '', column_id || 'todo', project_id || '', urgent ? 1 : 0, important ? 1 : 0, due || null, JSON.stringify(tags || []), sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/tasks/:id', (req, res) => {
  const fields = ['title', 'description', 'column_id', 'project_id', 'urgent', 'important', 'due', 'sort_order', 'risk_flag'];
  const sets = ["updated_at=datetime('now')"], vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      sets.push(f + '=?');
      vals.push(['urgent', 'important', 'risk_flag'].includes(f) ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  });
  if (req.body.tags !== undefined) { sets.push('tags=?'); vals.push(JSON.stringify(req.body.tags)); }
  vals.push(req.params.id);
  db.prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`).run(...vals);
  res.json({ ok: true }); broadcast('update');
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Task files ---
app.post('/api/tasks/:id/files', (req, res) => {
  const { name, size, type, data } = req.body;
  const r = db.prepare('INSERT INTO task_files (task_id, name, size, type, data) VALUES (?,?,?,?,?)').run(req.params.id, name, size, type, data);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.delete('/api/task-files/:id', (req, res) => {
  db.prepare('DELETE FROM task_files WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// ── Embedded terminals (ttyd) ──
// One ttyd process per project, on demand. Bound to 0.0.0.0 so it is reachable
// from the MacBook via Tailscale. Relying on Tailscale as the network trust
// boundary; no extra auth layer for now.
const TERMINAL_PORT_START = 7000;
const TERMINAL_PORT_END = 7099;
const terminals = new Map(); // project_id -> { proc, port, cwd, startedAt }

const PROJECTS_BASE_DIR = process.env.PROJECTS_BASE_DIR || path.join(os.homedir(), 'projects');

function getProjectPath(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  const ws = p.workspace_id ? db.prepare('SELECT * FROM workspaces WHERE id=?').get(p.workspace_id) : null;
  const wsName = ws ? ws.name : '_sin-workspace';
  return path.join(PROJECTS_BASE_DIR, wsName, p.name);
}

function isPortFreeOnOS(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

async function findFreeTerminalPort() {
  const inUse = new Set([...terminals.values()].map(t => t.port));
  for (let p = TERMINAL_PORT_START; p <= TERMINAL_PORT_END; p++) {
    if (inUse.has(p)) continue;
    if (await isPortFreeOnOS(p)) return p;
  }
  throw new Error('no free terminal ports');
}

app.post('/api/projects/:id/terminal/start', async (req, res) => {
  const projectId = req.params.id;
  const existing = terminals.get(projectId);
  if (existing && existing.proc && !existing.proc.killed && existing.proc.exitCode === null) {
    return res.json({ ok: true, port: existing.port, cwd: existing.cwd, reused: true });
  }

  const cwd = getProjectPath(projectId);
  if (!cwd) return res.status(404).json({ error: 'project not found' });
  if (!fs.existsSync(cwd)) {
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) {
      return res.status(500).json({ error: 'cannot create project dir: ' + e.message });
    }
  }

  let port;
  try { port = await findFreeTerminalPort(); } catch (e) { return res.status(503).json({ error: e.message }); }

  // ttyd flags:
  //   -p  port
  //   -i  bind interface (0.0.0.0 so Tailscale can reach it)
  //   -W  writable (allow input, not just view)
  //   -O  check origin (prevents CSRF from other sites)
  //   -t  client options (e.g. font)
  const shell = process.env.SHELL || '/bin/bash';
  const args = [
    '-p', String(port),
    '-i', '0.0.0.0',
    '-W',
    '-O',
    '-t', 'titleFixed=' + projectId,
    '-t', 'fontSize=13',
    shell,
  ];
  const proc = spawn('ttyd', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { proc, port, cwd, startedAt: new Date().toISOString() };
  terminals.set(projectId, entry);

  proc.on('exit', () => {
    const cur = terminals.get(projectId);
    if (cur && cur.proc === proc) terminals.delete(projectId);
  });
  proc.on('error', (err) => {
    console.error('ttyd error', err);
    terminals.delete(projectId);
  });

  res.json({ ok: true, port, cwd, reused: false });
});

app.post('/api/projects/:id/terminal/stop', (req, res) => {
  const entry = terminals.get(req.params.id);
  if (entry) {
    try { entry.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    terminals.delete(req.params.id);
  }
  res.json({ ok: true });
});

app.get('/api/projects/:id/terminal/status', (req, res) => {
  const entry = terminals.get(req.params.id);
  if (!entry) return res.json({ active: false });
  res.json({ active: true, port: entry.port, cwd: entry.cwd, startedAt: entry.startedAt });
});

app.get('/api/terminals', (req, res) => {
  const list = [];
  for (const [id, t] of terminals.entries()) list.push({ project_id: id, port: t.port, cwd: t.cwd, startedAt: t.startedAt });
  res.json({ terminals: list });
});

// Cleanup all ttyd processes on server shutdown.
function stopAllTerminals() {
  for (const t of terminals.values()) {
    try { t.proc.kill('SIGTERM'); } catch (e) {}
  }
  terminals.clear();
}
process.on('SIGINT',  () => { stopAllTerminals(); process.exit(0); });
process.on('SIGTERM', () => { stopAllTerminals(); process.exit(0); });

// WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// Start
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`K2 Project Admin running on http://${HOST}:${PORT}`));
