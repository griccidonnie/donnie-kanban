# Mission Control

Tablero Kanban personal con terminales embebidas y MCP server para integrar con Claude Code.

**Jerarquia:** Workspace > Area > Proyecto > Tareas

## Arquitectura

El sistema tiene 3 componentes:

| Componente | Puerto | Descripcion |
|---|---|---|
| **Kanban Server** (`server.js`) | 8080 | App web + API REST + WebSocket |
| **MCP Server** (`~/mcp-servers/mission-control/`) | 8765 | Puente entre Claude Code y la API |
| **ttyd** (opcional) | 7000-7099 | Terminales embebidas por proyecto |

```
Claude Code <--MCP--> MCP Server :8765 <--HTTP--> Kanban Server :8080 <--SQLite--> kanban.db
Browser     <--------------------------HTTP/WS------------------------> Kanban Server :8080
```

## Prerequisitos

Todo lo que necesita el equipo nuevo antes de instalar:

### Obligatorio

| Herramienta | Version minima | Instalacion |
|---|---|---|
| **Node.js** | >= 16 | `brew install node` |
| **npm** | (viene con Node) | - |
| **Git** | cualquiera | `brew install git` (o Xcode CLI tools) |
| **Claude Code** | cualquiera | `npm install -g @anthropic-ai/claude-code` |

### Opcional

| Herramienta | Para que | Instalacion |
|---|---|---|
| **ttyd** | Terminales embebidas en el browser | `brew install ttyd` |
| **Tailscale** | Acceder desde otro equipo via VPN | `brew install --cask tailscale` |

> **ttyd** no es indispensable. Sin el, todo funciona igual; solo el boton de terminal en cada proyecto no hara nada.
>
> **Tailscale** no es indispensable. Solo sirve para acceder al tablero desde otra maquina (ej: MacBook > Mac Mini). Si usas Mission Control solo en un equipo, no lo necesitas.

## Instalacion desde cero

### Paso 1: Clonar el repo y restaurar la DB

```bash
# Clonar
git clone https://github.com/griccidonnie/donnie-kanban.git
cd donnie-kanban

# Instalar dependencias
npm install

# Restaurar la base de datos desde el backup
# (copiar kanban.db al directorio del proyecto)
cp /path/to/backup/kanban.db ./kanban.db

# Verificar que arranca
node server.js
# Deberia decir: K2 Project Admin running on http://0.0.0.0:8080
# Ctrl+C para parar
```

> Si no tenes backup de `kanban.db`, el server crea una nueva con datos de ejemplo al arrancar.

### Paso 2: Instalar el MCP Server

El MCP server es un proyecto TypeScript separado que conecta Claude Code con la API de Mission Control.

```bash
# Crear directorio
mkdir -p ~/mcp-servers/mission-control
cd ~/mcp-servers/mission-control

# Copiar el codigo del MCP server desde el backup
# (o clonarlo si lo subiste a un repo separado)

# Instalar dependencias y compilar
npm install
npm run build
```

**Estructura del MCP server:**
```
~/mcp-servers/mission-control/
  src/           # TypeScript source
  build/         # Compilado (index.js, server.js, api.js, tools.js, http.js)
  package.json   # deps: @modelcontextprotocol/sdk, express
  tsconfig.json
```

**Dependencias del MCP server (`package.json`):**
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4",
    "express": "^4.22.1"
  }
}
```

### Paso 3: Registrar el MCP Server en Claude Code

```bash
# Agregar al config global de Claude Code
claude mcp add --transport http mission-control http://127.0.0.1:8765/mcp
```

Esto agrega a `~/.claude.json`:
```json
{
  "mcpServers": {
    "mission-control": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

### Paso 4: Crear Launch Agents (auto-arranque en macOS)

Estos archivos hacen que ambos servicios arranquen automaticamente al encender el equipo.

**MCP Server** - crear `~/Library/LaunchAgents/com.openclaw.mission-control-mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.mission-control-mcp</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/TU_USUARIO/mcp-servers/mission-control/build/index.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>MCP_MODE</key>
        <string>http</string>
        <key>MCP_HTTP_PORT</key>
        <string>8765</string>
        <key>MCP_HTTP_HOST</key>
        <string>0.0.0.0</string>
        <key>MISSION_CONTROL_URL</key>
        <string>http://127.0.0.1:8080</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>/Users/TU_USUARIO/mcp-servers/mission-control</string>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/TU_USUARIO/Library/Logs/mission-control-mcp/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/TU_USUARIO/Library/Logs/mission-control-mcp/stderr.log</string>
</dict>
</plist>
```

> Reemplazar `TU_USUARIO` con tu username. En Intel Mac cambiar `/opt/homebrew/bin/node` por `/usr/local/bin/node`.

**Cargar los servicios:**
```bash
# Crear directorio de logs
mkdir -p ~/Library/Logs/mission-control-mcp

# Cargar el MCP server
launchctl load ~/Library/LaunchAgents/com.openclaw.mission-control-mcp.plist

# Para el Kanban server, podes crear un plist similar o simplemente correrlo manual:
node server.js
```

### Paso 5: Configurar Claude Code para este proyecto

El proyecto usa un `.claude/settings.json` con permisos amplios y settings locales para MCP:

```bash
# Estos archivos ya estan en el repo (.claude/), se restauran con el git clone
# Verificar que existen:
cat .claude/settings.json
# Deberia mostrar: {"permissions":{"allow":["Bash(*)","Read(*)","Write(*)","Edit(*)"],"deny":[]}}
```

Ademas, el archivo `~/.claude/CLAUDE.md` (global) contiene instrucciones para que Claude use automaticamente el MCP de Mission Control para trackear tareas. Ese archivo hay que restaurarlo manualmente o recrearlo.

## Variables de entorno

| Variable | Default | Descripcion |
|---|---|---|
| `PORT` | `8080` | Puerto del Kanban server |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `PROJECTS_BASE_DIR` | `~/projects` | Raiz para crear directorios de proyectos (usado por ttyd) |
| `MISSION_CONTROL_URL` | `http://127.0.0.1:8080` | URL del kanban (usada por el MCP server) |
| `MCP_MODE` | `stdio` | `http` para modo HTTP, `stdio` para modo pipe |
| `MCP_HTTP_PORT` | `8765` | Puerto del MCP server en modo HTTP |

## Que respaldar

| Archivo/Directorio | Critico | Que contiene |
|---|---|---|
| `kanban.db` | **SI** | Todos los workspaces, areas, proyectos, tareas, archivos adjuntos |
| `~/mcp-servers/mission-control/` | SI | Codigo del MCP server (no esta en el repo del kanban) |
| `~/.claude/CLAUDE.md` | SI | Instrucciones globales de Claude (reglas de tracking, etc.) |
| `~/.claude.json` | SI | Config de MCP servers para Claude Code |
| `~/Library/LaunchAgents/com.openclaw.mission-control-mcp.plist` | Util | Auto-arranque del MCP server |
| `.claude/settings.json` | Menor | Permisos del proyecto (ya en el repo) |

> `kanban.db` es el archivo mas importante. Sin el, perdes toda la data.

## Checklist de restauracion

Para pedirle a Claude en un equipo nuevo:

```
Necesito restaurar Mission Control. El README tiene todas las instrucciones.
Tengo el repo en GitHub y un backup de kanban.db + el directorio mcp-servers/mission-control.

1. Instala Node.js y ttyd con brew
2. Clona el repo, npm install, copia kanban.db
3. Copia el MCP server a ~/mcp-servers/mission-control, npm install, npm run build
4. Registra el MCP server en Claude Code
5. Crea el Launch Agent para el MCP server
6. Arranca todo y verifica que funcione
```

## Stack tecnico

- **Backend:** Node.js + Express 5 + ws (WebSockets)
- **Base de datos:** SQLite3 via better-sqlite3 (WAL mode)
- **Frontend:** HTML + CSS + JavaScript vanilla (un solo archivo: `public/index.html`)
- **MCP Server:** TypeScript + @modelcontextprotocol/sdk + Express 4
- **Terminales:** ttyd (opcional, proceso externo)

## API Endpoints

### Data
- `GET /api/data` - Todo: workspaces, areas, columnas, proyectos, tareas

### Workspaces
- `POST /api/workspaces` | `PUT /api/workspaces/:id` | `DELETE /api/workspaces/:id`

### Areas
- `POST /api/areas` | `PUT /api/areas/:id` | `DELETE /api/areas/:id`

### Proyectos
- `POST /api/projects` | `PUT /api/projects/:id` | `DELETE /api/projects/:id`
- `POST /api/projects/:id/refs` | `DELETE /api/refs/:id`
- `POST /api/projects/:id/files` | `DELETE /api/project-files/:id`
- `POST /api/projects/:id/terminal/start` | `POST /api/projects/:id/terminal/stop`

### Tareas
- `POST /api/tasks` | `PUT /api/tasks/:id` | `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/files` | `DELETE /api/task-files/:id`

### WebSocket
- Conexion en `/` - recibe `{"type":"update"}` cuando hay cambios
