# Roadmap: Mission Control → AI Software Factory

Evolucionar Mission Control de un kanban personal a un orquestador de desarrollo de software asistido por IA.

## Stack

| Pieza | Herramienta | Rol |
|---|---|---|
| UI + Orquestador | **Mission Control** | Panel central, pipeline runner, intake queue |
| Codigo | **GitHub** | Repos, PRs, Actions (CI) |
| Agente IA | **Claude Code SDK** | Escribe codigo, corre tests, abre PRs |
| Deploy | **Coolify** | Staging/prod desde git push |
| Ambientes locales | **Docker Compose** | On-demand por proyecto |
| Integraciones | **MCP servers** | GitHub, Docker, Mission Control |

```
Mission Control ──MCP──► Claude Code SDK (agente)
       │
       ├──HTTP──► GitHub API (repos, PRs, Actions)
       ├──HTTP──► Coolify API (deploy staging/prod)
       └──Shell──► Docker Compose (ambientes locales)
```

---

## Fase 0 — Project Registry

**Duracion:** 1-2 dias

**Objetivo:** Que Mission Control sepa todo sobre cada proyecto, no solo el nombre y color.

**Cambios:**

- Extender tabla `projects` con campos nuevos:
  - `repo_url` — URL del repo en GitHub
  - `stack` — node, python, go, static...
  - `local_port` — puerto local cuando corre
  - `compose_file` — path al docker-compose.yml
  - `staging_url` — URL en Coolify
  - `prod_url` — URL de produccion
- Actualizar el panel de edicion de proyecto para mostrar/editar estos campos
- En la vista Project Detail: mostrar URLs clickeables, estado del repo

**Validacion:** Abrir un proyecto en Mission Control y ver su repo de GitHub, su URL de staging, su stack. Todo editable.

---

## Fase 1 — GitHub desde Mission Control

**Duracion:** 2-3 dias

**Objetivo:** Crear repos y ver su estado sin salir de Mission Control.

**Cambios:**

- Integrar GitHub API (token personal guardado en config del server)
- Boton "Crear repo" en el flujo de nuevo proyecto:
  - Crea repo en GitHub (privado, con README)
  - Scaffoldea estructura segun el stack elegido (template basico)
  - Push inicial
  - Guarda `repo_url` en el proyecto
- Boton "Vincular repo" para proyectos existentes (pegar URL)
- En la vista del proyecto: mostrar ultimo commit, branches activas, PRs abiertas (consultando GitHub API)

**Validacion:** Crear proyecto "test-app" con stack "node" desde Mission Control → verificar que el repo aparece en GitHub con estructura inicial → ver la info del repo en Mission Control.

---

## Fase 2 — Ambientes locales on-demand

**Duracion:** 2-3 dias

**Objetivo:** Levantar y tirar ambientes de desarrollo con un click.

**Cambios:**

- Templates de `docker-compose.yml` por stack (node, python, etc.) que se generan al crear el proyecto
- Botones en la UI del proyecto:
  - **▶ Levantar** → `docker compose up -d`
  - **■ Detener** → `docker compose down`
  - **Estado** → `docker compose ps`
- Indicador visual: bolita verde/roja en el sidebar si el ambiente esta corriendo
- Boton "Abrir app" → abre `http://localhost:{local_port}`
- La terminal embebida (ttyd) sigue funcionando igual

**Validacion:** Crear proyecto → levantar ambiente → ver la app en el browser → detener → verificar que los containers se apagaron. Todo desde Mission Control.

---

## Fase 3 — Agent Runner

**Duracion:** 3-5 dias

> Este es el corazon de la evolucion.

**Objetivo:** Darle una instruccion a Claude Code desde Mission Control y que trabaje en el proyecto.

**Cambios:**

- Nueva tabla `agent_jobs`:
  - `id`, `project_id`, `instruction`, `status` (queued/running/done/failed), `branch`, `pr_url`, `output`, `created_at`, `completed_at`
- Endpoint `POST /api/agent/run`:
  - Recibe `project_id` + `instruction`
  - Clona/actualiza el repo local
  - Crea una rama (`agent/{job-id}`)
  - Invoca Claude Code SDK en modo headless dentro del directorio del proyecto
  - Captura output y lo streamea via WebSocket a la UI
  - Al terminar: commit, push, abre PR en GitHub
  - Actualiza el job con resultado y URL del PR
- Panel "Agent" en la UI del proyecto:
  - Campo de texto para la instruccion
  - Boton "Ejecutar"
  - Log en tiempo real (streaming)
  - Historial de jobs anteriores con status y links a PRs

**Validacion:** Abrir proyecto → escribir "agrega un endpoint GET /health que devuelva {status: ok}" → ver al agente trabajar en tiempo real → ver el PR en GitHub → mergear.

---

## Fase 4 — Intake Queue

**Duracion:** 2-3 dias

**Objetivo:** Recibir pedidos de otros y aprobarlos antes de que el agente trabaje.

**Cambios:**

- Nueva tabla `requests`:
  - `id`, `project_id`, `description`, `submitted_by`, `status` (pending/approved/rejected/clarification), `agent_job_id`, `notes`, `created_at`
- Endpoint publico `POST /api/requests` (sin auth, con rate limit basico)
- Pagina publica simple `/request/{project-id}` — form con: nombre, descripcion del pedido
- Panel "Inbox" en Mission Control:
  - Lista de requests pendientes agrupados por proyecto
  - Botones: Aprobar, Rechazar, Pedir aclaracion
  - Al aprobar → crea un `agent_job` automaticamente y dispara el Agent Runner
- Notificacion en el sidebar: badge con cantidad de requests pendientes

**Validacion:** Abrir el form publico → enviar "Necesito que el boton principal sea verde" → verlo en el inbox → aprobar → ver al agente trabajar → PR aparece en GitHub.

---

## Fase 5 — Deploy a Staging

**Duracion:** 2-3 dias

**Prerequisito:** Tener Coolify corriendo en un servidor Linux (VPS o VM local).

**Objetivo:** Deploy automatico o manual a staging via Coolify.

**Cambios:**

- Configuracion en Mission Control: `coolify_url`, `coolify_api_token`
- Al crear proyecto: opcion de crear la app en Coolify (via API) y vincularla al repo de GitHub
- Guardar `staging_url` y `coolify_app_id` en el proyecto
- Botones en la UI:
  - **"Deploy to staging"** → triggerea deploy via Coolify API
  - **"Abrir staging"** → abre la URL
  - **"Ver logs"** → muestra logs de Coolify
- Opcionalmente: auto-deploy cuando se mergea un PR a `main` (Coolify soporta webhooks de GitHub)

**Validacion:** Mergear el PR del agente → ver que Coolify despliega → abrir la URL de staging desde Mission Control → ver la app corriendo.

---

## Fase 6 — Pipeline SDLC configurable

**Duracion:** 5-7 dias

**Objetivo:** Definir stages configurables por proyecto que el trabajo debe recorrer.

**Cambios:**

- Nueva tabla `pipeline_stages`:
  - `id`, `project_id`, `name`, `type` (manual/agent/ci), `sort_order`, `config` (JSON)
- Nueva tabla `pipeline_runs`:
  - `id`, `request_id`, `current_stage`, `status`, `history` (JSON log de cada stage)
- Stages default (configurable por proyecto):
  1. **Analisis** (agent) — el agente lee la documentacion del proyecto y el request, propone approach
  2. **Implementacion** (agent) — el agente escribe el codigo
  3. **Tests** (ci) — GitHub Actions corre tests automaticamente
  4. **Review** (manual) — revision humana del PR
  5. **Staging** (auto) — merge a staging, deploy via Coolify
  6. **Aprobacion** (manual) — verificacion en staging
  7. **Produccion** (manual/auto) — deploy final
- Dashboard visual mostrando en que stage esta cada request (pipeline view)
- Cada stage puede avanzar automaticamente o esperar aprobacion manual

**Validacion:** Un request recorre el pipeline completo: agente analiza → agente implementa → CI pasa tests → revision humana → deploy a staging → aprobacion → produccion.

---

## Resumen visual

```
Fase 0   Fase 1    Fase 2      Fase 3         Fase 4       Fase 5      Fase 6
─────────────────────────────────────────────────────────────────────────────────
Project  GitHub    Docker      Agent          Inbox        Coolify     Pipeline
Registry  API      Compose     Runner         Queue        Deploy      SDLC
                                  │              │            │           │
                                  └──────────────┴────────────┴───────────┘
                                        Todo conectado por WebSocket
                                        para updates en tiempo real
```

Cada fase es independiente y validable por separado. Tiempo total estimado: 4-6 semanas trabajando de a una fase.

---

## Principios de diseno

- **Una herramienta por funcion.** No hay overlap entre componentes.
- **Mission Control es el cerebro.** Todo se orquesta desde ahi, sin n8n ni herramientas externas de workflow.
- **Claude Code es el unico agente.** No hace falta OpenClaw, OpenHands ni otros frameworks de agentes. Claude Code SDK tiene subagents, hooks, MCP y modo headless — es suficiente.
- **Cada fase entrega valor.** No hay fases "de infraestructura" que no se puedan usar solas.
- **El humano aprueba.** Nada se despliega ni se mergea sin aprobacion explicita (configurable por stage).
