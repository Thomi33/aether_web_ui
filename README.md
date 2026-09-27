# ⚡ Aether Web UI

Interfaz web del agente **Aether** (réplica del prototipo `Aether-Workspace.html`).
Frontend estático (HTML + CSS + JS, sin build, sin dependencias) que habla con el
backend FastAPI de Aether mediante SSE para streaming de tokens en vivo.

![tema](https://img.shields.io/badge/tema-oscuro%20%2B%20acento%20teal-2ce5c4)

## ✨ Features

- **Chat con streaming real (SSE)**: tokens en vivo, actividad del agente
  (`agent_loop`, tools, memoria) y botón de stop.
- **Adjuntos 📎 (imágenes y archivos)**: se suben en base64 con el mensaje.
  El backend los guarda en `~/Aether/adjuntos/`, embebe el contenido de los
  archivos de texto en la orden y describe las imágenes con el modelo de
  visión (`MODELO_VISION`). Aether también los puede releer después con sus
  tools de filesystem.
- **Configuración de la TUI desde la web**: edita la *misma* `config.json` que
  usa la TUI (`OLLAMA_HOST`, `SEARXNG_URL`, `TEMPERATURE`, `MAX_TOKENS`,
  `NUM_PREDICT`, `NUM_CTX`, `TIMEOUT_CMD`, `MAX_TURNOS_CONTEXTO`,
  `MODO_AUTONOMO`, `TOOL_CALLING_NATIVO`) con la validación idéntica del
  `ConfigManager`. La TUI lo ve en su próximo arranque.
- **Workspace modal** (sidebar ▸ WORKSPACE/SYSTEM; cada sección abre su tab):
  - **▤ Proyectos**: registro de proyectos (nombre + ruta + descripción) en
    `~/Aether/proyectos.json`.
  - **◈ Memoria**: el **resumen acumulativo** que Aether recuerda (rolling
    summary de la DB) editable en caliente + botón *Consolidar ahora*
    (equivalente a `/memory` de la TUI) + ABM de **recuerdos** permanentes
    (hechos con categoría e importancia).
  - **✦ Skills**: catálogo de `skills/<nombre>/SKILL.md`, ver contenido,
    crear y borrar.
  - **◎ Tareas**: lista simple (pendiente / en curso / hecha) en
    `~/Aether/tareas.json`.
  - **🔌 MCPs**: toggle activar/desactivar (el `/mcps` de la TUI), ver las
    tools que expone cada server, **agregar MCP custom** (stdio: command, args
    y `env` línea-por-línea). Los valores de `env` (tokens) viajan
    **enmascarados**: la API nunca los devuelve en claro y un valor enmascarado
    al guardar conserva el secreto real.
  - **🎮 Roblox**: iniciar/detener el runtime autónomo con proveedor de visión
    (`hybrid`/`google`/`ollama`) — el `/play-roblox` de la TUI.
  - **⚡ Effort & Agente**: nivel de esfuerzo low/medium/high/max con el mismo
    mapeo a `TEMPERATURE`/`NUM_CTX`/`NUM_PREDICT` del `/effort` de la TUI
    (efecto **inmediato**) y selector de agente build/plan (`/agents`).
- **System prompt editable sin tocar código**:
  - `override` → reemplaza la persona por defecto.
  - `extra` → se agrega a **todos** los prompts (máxima prioridad).
  - `sintesis_extra` → solo para la persona de síntesis.
  - **Preview** en vivo de los prompts finales que verá el modelo.
- **Cuenta y preferencias** (Settings ▸ Cuenta): perfil de usuario (nombre,
  bio, timezone, idioma), avatar persistente y preferencias de la interfaz
  (tema, idioma, modo compacto, notificaciones), todo guardado vía
  `/api/account/*`.
- **Selector de modelos** leído desde Ollama (`/api/tags`), con el activo marcado.
- **Panel de runtime**: modelo, host, contexto, temperatura, effort, agente y
  estado de los overrides de prompt.
- **Conversaciones** persistidas en `localStorage`, con lista lateral y borrado.
- **Render de código**: fences ```lang, `inline`, **negrita** y saltos de línea.

## 📡 API consumida

La UI no asume nada del backend más allá de estos endpoints (proyecto Aether,
`backend/api/main.py`):

| Endpoint | Método | Uso |
|---|---|---|
| `/api/health` | GET | Estado del API y de Ollama (status card). |
| `/api/status` | GET | Modelo activo, host, `NUM_CTX`, `TEMPERATURE`, effort, agente, flags del prompt. |
| `/api/chat/stream` | POST | Chat con streaming SSE (`token`, `node`, `log`, `done`, `error`). Acepta `attachments: [{name, mime, data(base64)}]`. |
| `/ws/chat` | WS | Socket directo: mismo contrato de eventos, multi-mensaje por conexión. También acepta `attachments`. |
| `/api/stop` | POST | Aborta la generación en curso. |
| `/api/config` | GET / POST | Lee/guarda la config de la TUI (misma validación que `ConfigManager`). |
| `/api/system-prompt` | GET / POST | Lee/guarda las 3 claves del system prompt. |
| `/api/system-prompt/preview` | GET | Prompt final ya compuesto (`core/agent/prompts.py`). |
| `/api/models` | GET / POST | Lista los modelos de Ollama y cambia el activo. |
| `/api/memory/summary` | GET / POST | Lee/edita el resumen acumulativo (rolling summary). |
| `/api/memory/consolidate` | POST | Fuerza la consolidación con turnos pendientes (`/memory consolidar`). |
| `/api/memory/recuerdos` | GET / POST | Lista / agrega recuerdos permanentes (categoría, importancia). |
| `/api/memory/recuerdos/{id}` | DELETE | Borra un recuerdo. |
| `/api/skills` | GET / POST | Lista / crea skills (`skills/<nombre>/SKILL.md`). |
| `/api/skills/{name}` | GET / DELETE | Lee el contenido completo / borra la skill. |
| `/api/mcps` | GET / POST | Lista servers MCP (env enmascarado) / agrega un MCP custom. |
| `/api/mcps/{name}` | PATCH / DELETE | Edita/togglea / borra un server MCP (env enmascarado = conservar). |
| `/api/mcps/{name}/tools` | GET | Conecta al server y lista sus tools en vivo. |
| `/api/attachments/upload` | POST | Sube adjuntos como `multipart/form-data` (campo `files`, múltiple) antes de enviar el mensaje; el backend los guarda en `~/Aether/adjuntos/`. |
| `/api/effort` | GET / POST | Nivel de esfuerzo (aplica temp/ctx/num_predict como `/effort`). |
| `/api/agent` | GET / POST | Agente activo build/plan (como `/agents`). |
| `/api/agents` | GET / POST | Lista los agentes disponibles + el activo / crea un agente custom (`name`, `description`, `system_prompt`, …). |
| `/api/account/profile` | GET / POST | Perfil de usuario (nombre, bio, timezone, idioma). |
| `/api/account/preferences` | GET / POST | Preferencias de la UI (tema, idioma, modo compacto, notificaciones). |
| `/api/account/avatar` | POST | Sube el avatar como `multipart/form-data` (campo `file`). |
| `/api/roblox` | POST | `start`/`stop`/`status` del runtime autónomo (`/play-roblox`). |
| `/api/roblox/status` | GET | Estado del runtime (running, provider, pid). |
| `/api/proyectos` | GET / POST | Registro de proyectos (`~/Aether/proyectos.json`). |
| `/api/proyectos/{name}` | DELETE | Quita un proyecto del registro. |
| `/api/tareas` | GET / POST | Lista / crea tareas (`~/Aether/tareas.json`). |
| `/api/tareas/{id}` | PATCH / DELETE | Cambia estado/notas / borra una tarea. |

## 🚀 Cómo se sirve

El camino simple (instalado con el instalador o a mano):

```bash
aether web     # levanta el backend y abre el navegador — aliases: aether server / aether gateway
```

También manual: el backend de Aether sirve esta carpeta como estático. Orden de
resolución en `backend/core/config.py` → `resolver_web_ui_dir()`:

1. `WEB_UI_DIR` (variable de entorno o `backend/.env`)
2. `~/aether_web_ui/web` ← **este repo en su ruta por defecto**
3. `<proyecto_aether>/web_ui` (copia de desarrollo)

```bash
git clone https://github.com/Thomi33/aether_web_ui.git ~/aether_web_ui

cd ~/mi_proyecto_crew     # proyecto Aether
./backend/run.sh          # → http://localhost:8000
```

Si lo clonás en otra ruta, apuntá el backend explícitamente en `backend/.env`:

```env
WEB_UI_DIR=/ruta/a/aether_web_ui/web
```

### Desarrollo del frontend (sin backend sirviendo estáticos)

```bash
./serve.sh                # http://localhost:5173  (inyecta AETHER_API_BASE)
PORT=5173 AETHER_API_BASE=http://localhost:8000 ./serve.sh
```

`serve.sh` copia `web/` a un temporal e inyecta `window.AETHER_API_BASE`, que
`app.js` usa como base para todas las llamadas (vacío = mismo origen).

## 🧠 System prompt compartido (TUI ⇄ Web)

Las tres claves viven en `core/config/config.json`, así que **la TUI y la Web UI
comparten el mismo estado** y ninguna requiere tocar código:

```json
"SYSTEM_PROMPT_OVERRIDE": "",
"SYSTEM_PROMPT_EXTRA": "",
"SYSTEM_PROMPT_SINTESIS_EXTRA": ""
```

| Clave | Efecto |
|---|---|
| `SYSTEM_PROMPT_OVERRIDE` | Reemplaza la persona por defecto (la memoria y el contexto se siguen agregando). |
| `SYSTEM_PROMPT_EXTRA` | Se concatena con máxima prioridad a **todos** los prompts. |
| `SYSTEM_PROMPT_SINTESIS_EXTRA` | Solo para la persona de síntesis (`construir_persona_sintesis`, respuestas sin tool calling). |

`""` (vacío) = deshabilitado → se usa el prompt por defecto de
`core/agent/prompts.py`.

Se editan desde **Settings ▸ System Prompt** en la Web UI (con *Preview*) o
desde la TUI con el comando `/prompt` (`/prompt`, `/prompt override <texto>`,
`/prompt extra <texto>`, `/prompt sintesis <texto>`, `/prompt clear all`).

## 📝 Notas

- Las conversaciones viven en el navegador (`localStorage`, últimas 50); la
  memoria de largo plazo sigue en el backend (`~/Aether/db`).
- Sin dependencias: no hace falta `npm install` ni build.
- Tema oscuro con acento teal (local-first).