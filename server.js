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
    "connect-src 'self' ws: wss: http://*.ts.net:* https://*.ts.net:*; " +
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
    workspace_id TEXT DEFAULT NULL REFERENCES workspaces(id) ON DELETE SET DEFAULT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#58a6ff',
    notes TEXT DEFAULT '',
    workspace_id TEXT DEFAULT NULL REFERENCES workspaces(id) ON DELETE SET DEFAULT,
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
    project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET DEFAULT,
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

  CREATE TABLE IF NOT EXISTS pipeline_stages (
    id TEXT PRIMARY KEY,
    project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'manual',
    sort_order INTEGER DEFAULT 0,
    config TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    request_id TEXT DEFAULT '',
    project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET DEFAULT,
    current_stage TEXT DEFAULT '',
    status TEXT DEFAULT 'running',
    history TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET DEFAULT,
    description TEXT NOT NULL,
    submitted_by TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    agent_job_id TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET DEFAULT,
    instruction TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    branch TEXT DEFAULT '',
    pr_url TEXT DEFAULT '',
    output TEXT DEFAULT '',
    error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
`);

// Migrations
try { db.exec(`ALTER TABLE projects ADD COLUMN priority INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN risk_flag INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE projects ADD COLUMN area_id TEXT DEFAULT ''`); } catch(e) {}
try { db.exec("ALTER TABLE projects ADD COLUMN repo_url TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE projects ADD COLUMN stack TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE projects ADD COLUMN local_port INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE projects ADD COLUMN compose_file TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE projects ADD COLUMN staging_url TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE projects ADD COLUMN prod_url TEXT DEFAULT ''"); } catch(e) {}

// Data migration: coerce empty-string FK columns to NULL (fixes FK constraint violations)
db.prepare("UPDATE areas SET workspace_id=NULL WHERE workspace_id=''").run();
db.prepare("UPDATE projects SET workspace_id=NULL WHERE workspace_id=''").run();
db.prepare("UPDATE tasks SET project_id=NULL WHERE project_id=''").run();
db.prepare("UPDATE pipeline_stages SET project_id=NULL WHERE project_id=''").run();
db.prepare("UPDATE pipeline_runs SET project_id=NULL WHERE project_id=''").run();
db.prepare("UPDATE requests SET project_id=NULL WHERE project_id=''").run();
db.prepare("UPDATE agent_jobs SET project_id=NULL WHERE project_id=''").run();

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
  const wsId = wsExists ? 'k2' : null;
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

  const agent_jobs = db.prepare('SELECT id, project_id, instruction, status, branch, pr_url, error, created_at, completed_at FROM agent_jobs ORDER BY created_at DESC LIMIT 50').all();
  const requests = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 50').all();
  const pipeline_runs = db.prepare('SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT 50').all();
  pipeline_runs.forEach(r => { try { r.history = JSON.parse(r.history); } catch(e) { r.history = []; } });

  res.json({ workspaces, areas, columns, projects, tasks, agent_jobs, requests, pipeline_runs });
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
  db.prepare("UPDATE areas SET workspace_id=NULL WHERE workspace_id=?").run(req.params.id);
  db.prepare("UPDATE projects SET workspace_id=NULL WHERE workspace_id=?").run(req.params.id);
  db.prepare('DELETE FROM workspaces WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// --- Areas ---
app.post('/api/areas', (req, res) => {
  const { id, name, icon, workspace_id } = req.body;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM areas').get().n;
  db.prepare('INSERT INTO areas (id, name, icon, workspace_id, sort_order) VALUES (?,?,?,?,?)').run(id, name, icon || '📂', workspace_id || null, sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/areas/:id', (req, res) => {
  const { name, icon, workspace_id, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (icon !== undefined) { sets.push('icon=?'); vals.push(icon); }
  if (workspace_id !== undefined) { sets.push('workspace_id=?'); vals.push(workspace_id || null); }
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
  const { id, name, color, workspace_id, area_id, repo_url, stack, local_port, compose_file, staging_url, prod_url } = req.body;
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM projects').get().n;
  db.prepare('INSERT INTO projects (id, name, color, workspace_id, area_id, repo_url, stack, local_port, compose_file, staging_url, prod_url, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, color || '#58a6ff', workspace_id || null, area_id || '', repo_url || '', stack || '', local_port || 0, compose_file || '', staging_url || '', prod_url || '', sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/projects/:id', (req, res) => {
  const { name, color, notes, sort_order, workspace_id, area_id, priority, repo_url, stack, local_port, compose_file, staging_url, prod_url } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (color !== undefined) { sets.push('color=?'); vals.push(color); }
  if (notes !== undefined) { sets.push('notes=?'); vals.push(notes); }
  if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
  if (workspace_id !== undefined) { sets.push('workspace_id=?'); vals.push(workspace_id || null); }
  if (area_id !== undefined) { sets.push('area_id=?'); vals.push(area_id); }
  if (priority !== undefined) { sets.push('priority=?'); vals.push(priority); }
  if (repo_url !== undefined) { sets.push('repo_url=?'); vals.push(repo_url); }
  if (stack !== undefined) { sets.push('stack=?'); vals.push(stack); }
  if (local_port !== undefined) { sets.push('local_port=?'); vals.push(local_port); }
  if (compose_file !== undefined) { sets.push('compose_file=?'); vals.push(compose_file); }
  if (staging_url !== undefined) { sets.push('staging_url=?'); vals.push(staging_url); }
  if (prod_url !== undefined) { sets.push('prod_url=?'); vals.push(prod_url); }
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE projects SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  res.json({ ok: true }); broadcast('update');
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare("UPDATE tasks SET project_id=NULL WHERE project_id=?").run(req.params.id);
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
    .run(id, title, description || '', column_id || 'todo', project_id || null, urgent ? 1 : 0, important ? 1 : 0, due || null, JSON.stringify(tags || []), sort);
  res.json({ ok: true }); broadcast('update');
});

app.put('/api/tasks/:id', (req, res) => {
  const fields = ['title', 'description', 'column_id', 'project_id', 'urgent', 'important', 'due', 'sort_order', 'risk_flag'];
  const sets = ["updated_at=datetime('now')"], vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      sets.push(f + '=?');
      let v = ['urgent', 'important', 'risk_flag'].includes(f) ? (req.body[f] ? 1 : 0) : req.body[f];
      if (f === 'project_id') v = v || null;
      vals.push(v);
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

// ── GitHub integration ──
// Uses the gh CLI (must be authenticated) to avoid storing tokens in config.

function ghApi(endpoint, method, body) {
  return new Promise((resolve, reject) => {
    const args = ['api', endpoint, '--method', method || 'GET'];
    if (body) { args.push('--input', '-'); }
    const proc = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `gh exited ${code}`));
      try { resolve(JSON.parse(stdout)); } catch(e) { resolve(stdout); }
    });
    if (body) { proc.stdin.write(JSON.stringify(body)); proc.stdin.end(); }
    else { proc.stdin.end(); }
  });
}

app.get('/api/github/user', async (req, res) => {
  try {
    const user = await ghApi('user');
    res.json({ ok: true, login: user.login, name: user.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/github/create-repo', async (req, res) => {
  const { project_id, name, private: isPrivate } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const repo = await ghApi('user/repos', 'POST', {
      name, private: isPrivate !== false, auto_init: true, description: `Created from Mission Control`
    });
    if (project_id) {
      db.prepare("UPDATE projects SET repo_url=? WHERE id=?").run(repo.html_url, project_id);
      broadcast('update');
    }
    res.json({ ok: true, repo_url: repo.html_url, clone_url: repo.clone_url, full_name: repo.full_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/github/link-repo', async (req, res) => {
  const { project_id, repo_url } = req.body;
  if (!project_id || !repo_url) return res.status(400).json({ error: 'project_id and repo_url required' });
  db.prepare("UPDATE projects SET repo_url=? WHERE id=?").run(repo_url, project_id);
  broadcast('update');
  res.json({ ok: true });
});

app.get('/api/github/repo-info/:projectId', async (req, res) => {
  const p = db.prepare('SELECT repo_url FROM projects WHERE id=?').get(req.params.projectId);
  if (!p || !p.repo_url) return res.json({ linked: false });
  const match = p.repo_url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return res.json({ linked: false });
  const fullName = match[1].replace(/\.git$/, '');
  try {
    const [repo, prs, commits] = await Promise.all([
      ghApi(`repos/${fullName}`),
      ghApi(`repos/${fullName}/pulls?state=open&per_page=5`),
      ghApi(`repos/${fullName}/commits?per_page=5`),
    ]);
    res.json({
      linked: true, full_name: fullName,
      default_branch: repo.default_branch,
      open_prs: prs.map(pr => ({ number: pr.number, title: pr.title, url: pr.html_url, user: pr.user.login, updated_at: pr.updated_at })),
      recent_commits: commits.map(c => ({ sha: c.sha.slice(0,7), message: c.commit.message.split('\n')[0], author: c.commit.author.name, date: c.commit.author.date })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Coolify integration ──
// Set COOLIFY_URL and COOLIFY_TOKEN env vars to enable.

const COOLIFY_URL = process.env.COOLIFY_URL || '';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';

function coolifyApi(endpoint, method, body) {
  if (!COOLIFY_URL || !COOLIFY_TOKEN) return Promise.reject(new Error('Coolify not configured. Set COOLIFY_URL and COOLIFY_TOKEN env vars.'));
  const url = COOLIFY_URL.replace(/\/$/, '') + '/api/v1' + endpoint;
  const opts = {
    method: method || 'GET',
    headers: { 'Authorization': 'Bearer ' + COOLIFY_TOKEN, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts).then(r => r.json());
}

app.get('/api/coolify/status', (req, res) => {
  res.json({ configured: !!(COOLIFY_URL && COOLIFY_TOKEN), url: COOLIFY_URL || null });
});

app.post('/api/coolify/deploy', async (req, res) => {
  const { project_id } = req.body;
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!p.staging_url) return res.status(400).json({ error: 'no staging_url configured' });
  try {
    const apps = await coolifyApi('/applications');
    const app = (apps.data || apps || []).find(a => a.fqdn && p.staging_url.includes(a.fqdn));
    if (!app) return res.status(404).json({ error: 'app not found in Coolify' });
    const result = await coolifyApi(`/applications/${app.uuid}/restart`, 'POST');
    res.json({ ok: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/coolify/apps', async (req, res) => {
  try {
    const apps = await coolifyApi('/applications');
    res.json({ ok: true, apps: apps.data || apps });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Pipeline SDLC ──

const DEFAULT_PIPELINE = [
  { name: 'Analisis', type: 'agent' },
  { name: 'Implementacion', type: 'agent' },
  { name: 'Tests', type: 'ci' },
  { name: 'Review', type: 'manual' },
  { name: 'Staging', type: 'auto' },
  { name: 'Aprobacion', type: 'manual' },
  { name: 'Produccion', type: 'manual' },
];

app.get('/api/pipeline/stages/:projectId', (req, res) => {
  let stages = db.prepare('SELECT * FROM pipeline_stages WHERE project_id=? ORDER BY sort_order').all(req.params.projectId);
  if (!stages.length) stages = DEFAULT_PIPELINE.map((s, i) => ({ id: `default-${i}`, project_id: req.params.projectId, ...s, sort_order: i, config: '{}' }));
  res.json({ stages });
});

app.post('/api/pipeline/stages', (req, res) => {
  const { project_id, stages } = req.body;
  if (!project_id || !stages) return res.status(400).json({ error: 'project_id and stages required' });
  db.prepare('DELETE FROM pipeline_stages WHERE project_id=?').run(project_id);
  const ins = db.prepare('INSERT INTO pipeline_stages (id, project_id, name, type, sort_order, config) VALUES (?,?,?,?,?,?)');
  stages.forEach((s, i) => {
    ins.run(s.id || `ps-${Date.now()}-${i}`, project_id, s.name, s.type || 'manual', i, JSON.stringify(s.config || {}));
  });
  broadcast('update');
  res.json({ ok: true });
});

app.get('/api/pipeline/runs', (req, res) => {
  const { project_id } = req.query;
  let query = 'SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT 50';
  let params = [];
  if (project_id) { query = 'SELECT * FROM pipeline_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 50'; params = [project_id]; }
  const runs = db.prepare(query).all(...params);
  runs.forEach(r => { try { r.history = JSON.parse(r.history); } catch(e) { r.history = []; } });
  res.json({ runs });
});

app.post('/api/pipeline/runs', (req, res) => {
  const { project_id, request_id } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id required' });
  let stages = db.prepare('SELECT * FROM pipeline_stages WHERE project_id=? ORDER BY sort_order').all(project_id);
  if (!stages.length) stages = DEFAULT_PIPELINE.map((s, i) => ({ ...s, sort_order: i }));
  const id = 'pr-' + Date.now();
  const firstStage = stages[0].name;
  db.prepare('INSERT INTO pipeline_runs (id, project_id, request_id, current_stage, status, history) VALUES (?,?,?,?,?,?)')
    .run(id, project_id, request_id || '', firstStage, 'running', JSON.stringify([{ stage: firstStage, status: 'active', started_at: new Date().toISOString() }]));
  broadcast('update');
  res.json({ ok: true, id, current_stage: firstStage });
});

app.put('/api/pipeline/runs/:id/advance', (req, res) => {
  const run = db.prepare('SELECT * FROM pipeline_runs WHERE id=?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  let history;
  try { history = JSON.parse(run.history); } catch(e) { history = []; }
  let stages = db.prepare('SELECT * FROM pipeline_stages WHERE project_id=? ORDER BY sort_order').all(run.project_id);
  if (!stages.length) stages = DEFAULT_PIPELINE.map((s, i) => ({ ...s, sort_order: i }));
  const currentIdx = stages.findIndex(s => s.name === run.current_stage);
  // Mark current as done
  const currentEntry = history.find(h => h.stage === run.current_stage && h.status === 'active');
  if (currentEntry) { currentEntry.status = 'done'; currentEntry.completed_at = new Date().toISOString(); }
  if (currentIdx >= stages.length - 1) {
    db.prepare("UPDATE pipeline_runs SET status='done', current_stage='', history=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(history), run.id);
    broadcast('update');
    return res.json({ ok: true, status: 'done' });
  }
  const nextStage = stages[currentIdx + 1].name;
  history.push({ stage: nextStage, status: 'active', started_at: new Date().toISOString() });
  db.prepare("UPDATE pipeline_runs SET current_stage=?, history=?, updated_at=datetime('now') WHERE id=?").run(nextStage, JSON.stringify(history), run.id);
  broadcast('update');
  res.json({ ok: true, current_stage: nextStage });
});

app.put('/api/pipeline/runs/:id/fail', (req, res) => {
  const { error } = req.body;
  const run = db.prepare('SELECT * FROM pipeline_runs WHERE id=?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  let history;
  try { history = JSON.parse(run.history); } catch(e) { history = []; }
  const currentEntry = history.find(h => h.stage === run.current_stage && h.status === 'active');
  if (currentEntry) { currentEntry.status = 'failed'; currentEntry.error = error || 'Failed'; currentEntry.completed_at = new Date().toISOString(); }
  db.prepare("UPDATE pipeline_runs SET status='failed', history=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(history), run.id);
  broadcast('update');
  res.json({ ok: true });
});

// ── Intake Queue (requests) ──

app.get('/api/requests', (req, res) => {
  const requests = db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all();
  res.json({ requests });
});

app.post('/api/requests', (req, res) => {
  const { project_id, description, submitted_by } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  const id = 'req-' + Date.now();
  db.prepare('INSERT INTO requests (id, project_id, description, submitted_by) VALUES (?,?,?,?)').run(id, project_id || null, description, submitted_by || 'anonymous');
  broadcast('update');
  res.json({ ok: true, id });
});

app.put('/api/requests/:id', (req, res) => {
  const { status, notes, agent_job_id } = req.body;
  const sets = [], vals = [];
  if (status !== undefined) { sets.push('status=?'); vals.push(status); }
  if (notes !== undefined) { sets.push('notes=?'); vals.push(notes); }
  if (agent_job_id !== undefined) { sets.push('agent_job_id=?'); vals.push(agent_job_id); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE requests SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true }); broadcast('update');
});

app.delete('/api/requests/:id', (req, res) => {
  db.prepare('DELETE FROM requests WHERE id=?').run(req.params.id);
  res.json({ ok: true }); broadcast('update');
});

// Public request form page
app.get('/request/:projectId', (req, res) => {
  const p = db.prepare('SELECT id, name, color FROM projects WHERE id=?').get(req.params.projectId);
  const projectName = p ? p.name : 'Proyecto';
  const projectId = p ? p.id : '';
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solicitud — ${projectName}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;padding:40px 16px;}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:500px;width:100%;}
  h1{font-size:20px;margin-bottom:4px;} .sub{color:#8b949e;font-size:14px;margin-bottom:24px;}
  label{display:block;font-size:13px;color:#8b949e;margin-bottom:4px;margin-top:16px;}
  input,textarea{width:100%;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;}
  textarea{min-height:120px;resize:vertical;}
  button{margin-top:20px;background:#238636;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:14px;cursor:pointer;width:100%;}
  button:hover{background:#2ea043;} .ok{color:#3fb950;text-align:center;margin-top:16px;font-size:14px;}
</style></head><body>
<div class="card">
  <h1>Nueva solicitud</h1>
  <div class="sub">${projectName}</div>
  <form id="f" onsubmit="return send(event)">
    <label>Tu nombre</label>
    <input id="name" placeholder="Nombre o email">
    <label>Descripcion del pedido *</label>
    <textarea id="desc" placeholder="Describe que necesitas..." required></textarea>
    <button type="submit">Enviar solicitud</button>
  </form>
  <div id="msg"></div>
</div>
<script>
async function send(e){
  e.preventDefault();
  const r=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:'${projectId}',description:document.getElementById('desc').value,submitted_by:document.getElementById('name').value||'anonymous'})});
  const j=await r.json();
  if(j.ok){document.getElementById('f').style.display='none';document.getElementById('msg').innerHTML='<div class="ok">Solicitud enviada. Gracias!</div>';}
}
</script></body></html>`);
});

// ── Agent Runner (Claude Code SDK) ──

const activeAgentJobs = new Map();

app.get('/api/agent/jobs/:projectId', (req, res) => {
  const jobs = db.prepare('SELECT id, project_id, instruction, status, branch, pr_url, error, created_at, completed_at FROM agent_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(req.params.projectId);
  res.json({ jobs });
});

app.get('/api/agent/job/:jobId', (req, res) => {
  const job = db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.post('/api/agent/run', async (req, res) => {
  const { project_id, instruction } = req.body;
  if (!project_id || !instruction) return res.status(400).json({ error: 'project_id and instruction required' });

  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!p.repo_url) return res.status(400).json({ error: 'project has no linked repo' });

  const jobId = 'aj-' + Date.now();
  const branch = 'agent/' + jobId;

  db.prepare('INSERT INTO agent_jobs (id, project_id, instruction, status, branch) VALUES (?,?,?,?,?)').run(jobId, project_id, instruction, 'running', branch);
  broadcast('update');
  res.json({ ok: true, job_id: jobId });

  // Run agent asynchronously
  runAgentJob(jobId, p, instruction, branch).catch(err => {
    db.prepare("UPDATE agent_jobs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(err.message, jobId);
    broadcast('update');
  });
});

async function runAgentJob(jobId, project, instruction, branch) {
  const match = project.repo_url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) throw new Error('invalid repo_url');
  const fullName = match[1].replace(/\.git$/, '');

  const projPath = getProjectPath(project.id);
  if (!projPath) throw new Error('cannot determine project path');

  // Clone or update repo
  if (!fs.existsSync(path.join(projPath, '.git'))) {
    if (!fs.existsSync(projPath)) fs.mkdirSync(projPath, { recursive: true });
    await spawnAsync('git', ['clone', project.repo_url, '.'], { cwd: projPath });
  } else {
    await spawnAsync('git', ['fetch', 'origin'], { cwd: projPath });
    await spawnAsync('git', ['checkout', 'main'], { cwd: projPath }).catch(() =>
      spawnAsync('git', ['checkout', 'master'], { cwd: projPath })
    );
    await spawnAsync('git', ['pull', '--ff-only'], { cwd: projPath }).catch(() => {});
  }

  // Create branch
  await spawnAsync('git', ['checkout', '-b', branch], { cwd: projPath });

  // Run Claude Code in print mode
  let output = '';
  try {
    output = await spawnAsync('claude', [
      '--print',
      '--dangerously-skip-permissions',
      instruction
    ], { cwd: projPath, timeout: 300000 });
  } catch(e) {
    output = e.message;
  }

  db.prepare("UPDATE agent_jobs SET output=? WHERE id=?").run(output.slice(0, 100000), jobId);
  broadcast('update');

  // Check if there are changes to commit
  const status = await spawnAsync('git', ['status', '--porcelain'], { cwd: projPath });
  if (!status.trim()) {
    db.prepare("UPDATE agent_jobs SET status='done', completed_at=datetime('now'), error='No changes produced' WHERE id=?").run(jobId);
    await spawnAsync('git', ['checkout', 'main'], { cwd: projPath }).catch(() =>
      spawnAsync('git', ['checkout', 'master'], { cwd: projPath })
    );
    await spawnAsync('git', ['branch', '-D', branch], { cwd: projPath }).catch(() => {});
    broadcast('update');
    return;
  }

  // Commit and push
  await spawnAsync('git', ['add', '-A'], { cwd: projPath });
  await spawnAsync('git', ['commit', '-m', `agent: ${instruction.slice(0, 72)}\n\nJob: ${jobId}`], { cwd: projPath });
  await spawnAsync('git', ['push', 'origin', branch], { cwd: projPath });

  // Create PR via gh
  let prUrl = '';
  try {
    const prOutput = await spawnAsync('gh', ['pr', 'create',
      '--title', `[Agent] ${instruction.slice(0, 72)}`,
      '--body', `Automated PR from Mission Control Agent Runner.\n\nJob: ${jobId}\nInstruction: ${instruction}`,
      '--head', branch,
      '--repo', fullName
    ], { cwd: projPath });
    const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) prUrl = urlMatch[0];
  } catch(e) {
    db.prepare("UPDATE agent_jobs SET error=? WHERE id=?").run('PR creation failed: ' + e.message, jobId);
  }

  db.prepare("UPDATE agent_jobs SET status='done', pr_url=?, completed_at=datetime('now') WHERE id=?").run(prUrl, jobId);

  // Return to main branch
  await spawnAsync('git', ['checkout', 'main'], { cwd: projPath }).catch(() =>
    spawnAsync('git', ['checkout', 'master'], { cwd: projPath })
  );
  broadcast('update');
}

function spawnAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const timer = opts && opts.timeout ? setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('timeout')); }, opts.timeout) : null;
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || stdout || `${cmd} exited ${code}`));
      resolve(stdout);
    });
    proc.on('error', reject);
  });
}

// ── Docker Compose (local environments) ──

const STACK_TEMPLATES = {
  node: {
    'docker-compose.yml': `services:\n  app:\n    image: node:20-alpine\n    working_dir: /app\n    volumes:\n      - .:/app\n    ports:\n      - "\${PORT:-3000}:3000"\n    command: sh -c "npm install && npm start"\n`,
  },
  python: {
    'docker-compose.yml': `services:\n  app:\n    image: python:3.12-slim\n    working_dir: /app\n    volumes:\n      - .:/app\n    ports:\n      - "\${PORT:-8000}:8000"\n    command: sh -c "pip install -r requirements.txt 2>/dev/null; python app.py"\n`,
  },
  go: {
    'docker-compose.yml': `services:\n  app:\n    image: golang:1.22-alpine\n    working_dir: /app\n    volumes:\n      - .:/app\n    ports:\n      - "\${PORT:-8080}:8080"\n    command: go run .\n`,
  },
  static: {
    'docker-compose.yml': `services:\n  web:\n    image: nginx:alpine\n    volumes:\n      - .:/usr/share/nginx/html:ro\n    ports:\n      - "\${PORT:-8080}:80"\n`,
  },
};

function getComposeFile(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  if (p.compose_file) return p.compose_file;
  const projPath = getProjectPath(projectId);
  if (!projPath) return null;
  const defaultPath = path.join(projPath, 'docker-compose.yml');
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

app.post('/api/docker/scaffold', (req, res) => {
  const { project_id } = req.body;
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const template = STACK_TEMPLATES[p.stack];
  if (!template) return res.status(400).json({ error: `no template for stack "${p.stack}"` });
  const projPath = getProjectPath(project_id);
  if (!projPath) return res.status(400).json({ error: 'cannot determine project path' });
  if (!fs.existsSync(projPath)) fs.mkdirSync(projPath, { recursive: true });
  for (const [file, content] of Object.entries(template)) {
    const filePath = path.join(projPath, file);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content);
  }
  const composePath = path.join(projPath, 'docker-compose.yml');
  db.prepare("UPDATE projects SET compose_file=? WHERE id=?").run(composePath, project_id);
  broadcast('update');
  res.json({ ok: true, compose_file: composePath });
});

function runDockerCompose(composePath, args) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(composePath);
    const proc = spawn('docker', ['compose', '-f', composePath, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || stdout || `docker compose exited ${code}`));
      resolve(stdout + stderr);
    });
  });
}

app.post('/api/docker/up', async (req, res) => {
  const { project_id } = req.body;
  const composePath = getComposeFile(project_id);
  if (!composePath) return res.status(400).json({ error: 'no compose file found' });
  try {
    const out = await runDockerCompose(composePath, ['up', '-d']);
    res.json({ ok: true, output: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/docker/down', async (req, res) => {
  const { project_id } = req.body;
  const composePath = getComposeFile(project_id);
  if (!composePath) return res.status(400).json({ error: 'no compose file found' });
  try {
    const out = await runDockerCompose(composePath, ['down']);
    res.json({ ok: true, output: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docker/status/:projectId', async (req, res) => {
  const composePath = getComposeFile(req.params.projectId);
  if (!composePath) return res.json({ running: false, containers: [] });
  try {
    const out = await runDockerCompose(composePath, ['ps', '--format', 'json']);
    const containers = out.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch(e) { return null; }
    }).filter(Boolean);
    res.json({ running: containers.some(c => c.State === 'running'), containers });
  } catch(e) { res.json({ running: false, containers: [], error: e.message }); }
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
