# Mission Control - System Design & Capabilities

## What is Mission Control

Mission Control is a personal project management system built as a self-hosted web application. It combines a visual kanban board, multiple task views, embedded terminals, and an AI integration layer (MCP) that allows Claude Code to read and write tasks programmatically.

It runs entirely on a single machine with no external services required. All data lives in a local SQLite database.

## Architecture Overview

```
+------------------+       +------------------+       +------------------+
|  Browser (UI)    | <---> |  Kanban Server   | <---> |  SQLite (WAL)    |
|  Single-page app |  HTTP |  Node.js/Express |       |  kanban.db       |
|  Vanilla JS      |  + WS |  :8080           |       |                  |
+------------------+       +--------+---------+       +------------------+
                                     |
                                     | spawns on demand
                                     v
                            +------------------+
                            |  ttyd processes   |
                            |  :7000-7099       |
                            |  one per project  |
                            +------------------+

+------------------+       +------------------+
|  Claude Code     | <---> |  MCP Server      |
|  (CLI / IDE)     |  MCP  |  TypeScript       |
|                  |  HTTP |  :8765            |
+------------------+       +--------+---------+
                                     |
                                     | HTTP calls
                                     v
                            +------------------+
                            |  Kanban Server   |
                            |  :8080 (same)    |
                            +------------------+
```

### Components

| Component | Technology | Port | Role |
|---|---|---|---|
| **Kanban Server** | Node.js, Express 5, ws, better-sqlite3 | 8080 | REST API, WebSocket broadcast, static file server, terminal process manager |
| **Frontend** | Vanilla HTML/CSS/JS (single file: `public/index.html`) | - | All UI: sidebar, views, modals, drag-and-drop, terminal drawer |
| **MCP Server** | TypeScript, @modelcontextprotocol/sdk, Express 4 | 8765 | Translates MCP tool calls into HTTP requests to the Kanban Server |
| **ttyd** | External binary (C) | 7000-7099 | Provides browser-accessible terminal sessions per project |
| **SQLite** | better-sqlite3, WAL mode | - | Single-file database with all application state |

## Data Model

### Hierarchy

```
Workspace (K2, Personal, ...)
  └── Area (Producto, Compliance, Herramientas, ...)
       └── Project (SOC 2, Adopcion IA, ...)
            └── Task (individual work items)
                 ├── Files (attachments, stored as base64 in DB)
                 └── Tags (JSON array of strings)
            ├── References (links: URLs with title and notes)
            └── Files (project-level attachments)
```

### Database Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `workspaces` | Top-level organizational containers | id, name, icon, sort_order |
| `areas` | Domains of responsibility within a workspace | id, name, icon, workspace_id, sort_order |
| `projects` | Work streams within an area | id, name, color, workspace_id, area_id, notes, priority, sort_order |
| `project_refs` | URL bookmarks attached to a project | project_id, title, url, notes |
| `project_files` | File attachments on projects (base64) | project_id, name, size, type, data |
| `tasks` | Individual work items | id, title, description (HTML), column_id, project_id, urgent, important, risk_flag, due, tags (JSON), sort_order |
| `task_files` | File attachments on tasks (base64) | task_id, name, size, type, data |
| `columns` | Kanban columns (customizable) | id, title, sort_order |

### Default Columns

| Column ID | Display Name | Purpose |
|---|---|---|
| `backlog` | Backlog | Ideas and future work |
| `todo` | To Do | Committed but not started |
| `in-progress` | In Progress | Currently being worked on |
| `review` | Review | Waiting for review or validation |
| `done` | Done | Completed |

### Task Flags

Each task has three boolean flags used for prioritization:

| Flag | Purpose |
|---|---|
| `urgent` | Time-sensitive, needs attention now |
| `important` | High impact, aligns with goals |
| `risk_flag` | Flagged as a risk or blocker |

These map to the Eisenhower Matrix quadrants:
- **Q1 (Do Now):** urgent + important
- **Q2 (Schedule):** not urgent + important
- **Q3 (Delegate):** urgent + not important
- **Q4 (Eliminate):** not urgent + not important

## Frontend Capabilities

### 5 Views

#### 1. Kanban Board (default)
- Columns displayed horizontally, each showing task cards
- **Drag-and-drop** cards between columns to change status
- Cards show: project badge (color-coded), title, urgency/importance flags, due date, tags, file count
- Double-click a card to edit it
- Filter by project, area, or status (active/done/all)

#### 2. List View
- Sortable table with all tasks
- **Full-text search** across title, description, and tags
- **Multi-filter dropdowns**: by project, status, tags, due date
- **Flag toggles**: filter by urgent, important, or risk
- **Sortable columns**: title, project, status, flags, due date, last updated
- Click any row to edit

#### 3. Eisenhower Matrix
- 2x2 grid organizing tasks by urgency and importance
- Q1 (top-left): Do Now — urgent + important
- Q2 (top-right): Schedule — not urgent + important
- Q3 (bottom-left): Delegate — urgent + not important
- Q4 (bottom-right): Eliminate — not urgent + not important
- Same card rendering as kanban, drag supported

#### 4. Portfolio View
- Overview of all projects with health indicators
- Each project shows: task distribution by column, completion percentage, priority level
- **Alert system** detects: critical tasks not started, overdue items, stalled progress, empty projects
- Alerts categorized as critical, warning, or info
- Sortable by priority, name, task count, or alert level
- Filterable by alert type

#### 5. Project Detail
- Deep dive into a single project
- Shows: project notes (rich text), references, files, all tasks grouped by column
- Inline editing of project metadata

### Sidebar

- **Workspace selector** (dropdown at top): switch between workspaces or view all
- **Area accordions**: collapsible groups that organize projects within a workspace
  - Click area header: filters all views to show only that area's tasks
  - Click chevron: collapse/expand without filtering
  - Hover reveals: "+" button (add project to area), "..." button (edit area)
  - Collapse state persisted in localStorage
- **Project list**: within each area, shows projects with color dot, name, active task count
  - Click: filters views to that project
  - Drag-and-drop to reorder
  - Hover reveals: terminal button, config button
- **"Todos" item**: shows all tasks, clears project/area filter
- **Navigation links**: Kanban, Lista, Eisenhower, Portfolio

### Task Editor Modal

- Title (text input)
- Project selector (dropdown)
- Urgency and importance toggle buttons
- Risk flag toggle
- Due date picker
- Tags input (comma-separated, rendered as chips)
- Rich text description editor with toolbar: bold, italic, headers, lists, links, code
- File attachments: drag-and-drop or click to upload, stored as base64 in SQLite
- Delete task button

### Slide Panel (edit sidebar entities)

- Used for editing workspaces, areas, and projects
- Slides in from the right with overlay
- Workspace edit: name, icon, delete
- Area edit: name, emoji icon, workspace assignment, delete
- Project edit: name, color picker, workspace, area (filtered by workspace), link to full detail, delete

### Other UI Features

- **Dark/Light theme**: toggle in header, persisted in localStorage
- **Real-time sync**: WebSocket connection receives "update" broadcasts; any change by any client (including MCP) triggers a full re-render on all connected browsers
- **Navigation state persistence**: current view, workspace, project filter, list filters, sort — all saved to localStorage and restored on refresh
- **URL hash routing**: `#kanban`, `#list`, `#eisenhower`, `#portfolio`, `#project` — supports browser back/forward
- **Dashboard stats**: header shows counts for backlog, to-do, in-progress, and overdue tasks
- **Sidebar resize**: draggable handle to adjust sidebar width, persisted

## Embedded Terminals

Each project can have a browser-based terminal session:

- Click the terminal icon (">_") on any project in the sidebar
- Server spawns a `ttyd` process bound to the project's filesystem directory
- Directory is derived from: `~/projects/{WorkspaceName}/{ProjectName}/`
- Terminal appears in a **multi-tab drawer** at the bottom-right of the screen
- Multiple terminals can be open simultaneously (one per project)
- Tabs show project name; click to switch, "x" to close tab (process keeps running)
- Drawer can be maximized to full screen
- "Stop" button sends SIGTERM to the ttyd process
- Ports allocated from 7000-7099, auto-finding free ports
- All ttyd processes are cleaned up on server shutdown (SIGINT/SIGTERM)

### Terminal drawer features
- Resizable (drag header to resize)
- Maximizable (full screen toggle)
- Multiple concurrent sessions (tabbed)
- Sessions persist across tab switches (iframe-based)
- "Hide" closes drawer without killing terminals

## MCP Server (AI Integration)

The MCP server enables Claude Code (or any MCP-compatible AI) to interact with Mission Control programmatically. It runs as an HTTP server on port 8765 and translates MCP tool calls into REST API requests to the Kanban Server.

### Available MCP Tools

| Tool | Description | Key Parameters |
|---|---|---|
| `list_projects` | List all projects with task counts by column | workspace_id (optional filter) |
| `get_project` | Full project detail: notes, refs, files, tasks by column | project_id (by ID or name, case-insensitive) |
| `create_project` | Create a new project | name, color, workspace_id, notes |
| `list_tasks` | List tasks with filters | project_id, column_id, workspace_id, urgent, important, exclude_done, limit |
| `create_task` | Create a new task | title, description, project_id, column_id, urgent, important, due, tags |
| `update_task` | Update task fields | task_id, title, description, project_id, urgent, important, risk_flag, due, tags |
| `move_task` | Move task to a different column | task_id, column_id |
| `get_priorities` | Tasks ordered by Eisenhower quadrant | workspace_id, project_id, include_done, limit |
| `search_tasks` | Free-text search across title, description, tags | query, include_done, limit |

### Smart Resolution

The MCP server supports referencing projects by **name or ID**, case-insensitively. For example:
- `project_id: "infra"` (exact ID)
- `project_id: "Infraestructura"` (display name)
- `project_id: "infraestructura"` (case-insensitive name)

Same for workspace references.

### How Claude Uses It

Claude Code has global instructions (`~/.claude/CLAUDE.md`) that tell it to:
1. Before starting work: create a task in Mission Control with status "in-progress"
2. After finishing: update the task description with a summary of what was done
3. Move the task to "done"

This means every piece of work Claude does is automatically tracked in the kanban board, visible in the browser UI in real-time via WebSocket.

## REST API Reference

### Data
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/data` | Everything: workspaces, areas, columns, projects (with refs/files), tasks (with files) |

### Workspaces
| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/workspaces` | id, name, icon | Create workspace |
| PUT | `/api/workspaces/:id` | name?, icon?, sort_order? | Update workspace |
| DELETE | `/api/workspaces/:id` | - | Delete (orphans projects and areas) |

### Areas
| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/areas` | id, name, icon, workspace_id | Create area |
| PUT | `/api/areas/:id` | name?, icon?, workspace_id?, sort_order? | Update area |
| DELETE | `/api/areas/:id` | - | Delete (clears area_id on projects) |

### Projects
| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/projects` | id, name, color, workspace_id, area_id | Create project |
| PUT | `/api/projects/:id` | name?, color?, notes?, workspace_id?, area_id?, priority?, sort_order? | Update project |
| DELETE | `/api/projects/:id` | - | Delete (orphans tasks) |
| POST | `/api/projects/:id/refs` | title, url, notes | Add reference link |
| DELETE | `/api/refs/:id` | - | Delete reference |
| POST | `/api/projects/:id/files` | name, size, type, data (base64) | Upload file |
| GET | `/api/project-files/:id/download` | - | Download file |
| DELETE | `/api/project-files/:id` | - | Delete file |

### Tasks
| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/tasks` | id, title, description, column_id, project_id, urgent, important, due, tags | Create task |
| PUT | `/api/tasks/:id` | title?, description?, column_id?, project_id?, urgent?, important?, risk_flag?, due?, sort_order?, tags? | Update task |
| DELETE | `/api/tasks/:id` | - | Delete task |
| POST | `/api/tasks/:id/files` | name, size, type, data (base64) | Upload file |
| DELETE | `/api/task-files/:id` | - | Delete file |

### Terminals
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/projects/:id/terminal/start` | Start ttyd for project (returns port) |
| POST | `/api/projects/:id/terminal/stop` | Stop ttyd for project |
| GET | `/api/projects/:id/terminal/status` | Check if terminal is active |
| GET | `/api/terminals` | List all active terminals |

### WebSocket
- Connect to `ws://host:8080/`
- Receives `{"type":"update"}` on any data change
- Used for real-time sync across browser tabs and MCP-triggered changes

## Real-Time Sync Flow

```
1. User edits task in browser
   -> POST /api/tasks/:id
   -> Server updates SQLite
   -> Server calls broadcast('update')
   -> All WebSocket clients receive {"type":"update"}
   -> Each client calls loadData() -> re-renders

2. Claude creates task via MCP
   -> MCP Server POST http://127.0.0.1:8080/api/tasks
   -> Server updates SQLite
   -> Server calls broadcast('update')
   -> Browser receives WebSocket update
   -> UI re-renders showing new task instantly
```

## Security Model

- **CSP headers**: script-src unsafe-inline (single-file app), frame-src allows same-host (for ttyd iframes)
- **X-Frame-Options**: DENY (prevents embedding)
- **Origin checking**: ttyd runs with `-O` flag (CSRF protection)
- **Network boundary**: Binds to 0.0.0.0 by default; relies on Tailscale or local network as trust boundary
- **No authentication**: Designed for single-user, local/VPN use only
- **File storage**: Base64 in SQLite, 50MB JSON body limit

## Environment Variables

| Variable | Default | Used By | Purpose |
|---|---|---|---|
| `PORT` | 8080 | Kanban Server | HTTP port |
| `HOST` | 0.0.0.0 | Kanban Server | Bind interface |
| `PROJECTS_BASE_DIR` | ~/projects | Kanban Server | Root for project directories (terminals) |
| `MISSION_CONTROL_URL` | http://127.0.0.1:8080 | MCP Server | Where MCP sends API requests |
| `MCP_MODE` | stdio | MCP Server | `http` for standalone, `stdio` for pipe mode |
| `MCP_HTTP_PORT` | 8765 | MCP Server | HTTP port when in http mode |
| `MCP_HTTP_HOST` | 0.0.0.0 | MCP Server | Bind interface for MCP HTTP |

## Technology Choices

| Choice | Reason |
|---|---|
| **Single HTML file** | Zero build step, instant iteration, easy to backup and share |
| **Vanilla JS (no framework)** | No build toolchain, no dependencies, full control, small payload |
| **SQLite with WAL** | Single-file database, concurrent reads, no server process needed |
| **better-sqlite3** | Synchronous API (simpler code), fastest Node.js SQLite binding |
| **Express 5** | Minimal HTTP framework, async error handling |
| **WebSocket (ws)** | Native Node.js WebSocket, no Socket.io overhead |
| **ttyd** | Battle-tested terminal-to-web bridge, lightweight C binary |
| **MCP protocol** | Standard AI tool integration, works with Claude Code out of the box |

## Limitations

- **Single user**: No authentication, no multi-tenancy
- **Single machine**: SQLite doesn't support remote access; all components must run on same host
- **File storage**: Attachments stored as base64 in SQLite — not suitable for very large files
- **No mobile optimization**: UI designed for desktop browsers
- **Terminal requires ttyd**: Must be installed separately (`brew install ttyd`)
- **No undo**: Deletions are permanent (no soft delete or trash)
