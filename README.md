# ⚡ Aether Web UI

Interfaz web del agente **Aether** (réplica del prototipo `Aether-Workspace.html`).
Frontend estático (HTML + CSS + JS, sin build, sin dependencias) que habla con el
backend FastAPI de Aether mediante SSE para streaming de tokens en vivo.

![tema](https://img.shields.io/badge/tema-oscuro%20%2B%20acento%20teal-2ce5c4)

## ✨ Features

- **Chat con streaming real (SSE)**: tokens en vivo, actividad del agente
  (`agent_loop`, tools, memoria) y botón de stop.
- **Configuración de la TUI desde la web**: edita la *misma* `config.json` que
  usa la TUI (`OLLAMA_HOST`, `SEARXNG_URL`, `TEMPERATURE`, `MAX_TOKENS`,
  `NUM_PREDICT`, `NUM_CTX`, `TIMEOUT_CMD`, `MAX_TURNOS_CONTEXTO`,
  `MODO_AUTONOMO`, `TOOL_CALLING_NATIVO`) con la validación idéntica del
  `ConfigManager`. La TUI lo ve en su próximo arranque.
- **System prompt editable sin tocar código**:
  - `override` → reemplaza la persona por defecto.
  - `extra` → se agrega a **todos** los prompts (máxima prioridad).
  - `sintesis_extra` → solo para la persona de síntesis.
  - **Preview** en vivo de los prompts finales que verá el modelo.
- **Selector de modelos** leído desde Ollama (`/api/tags`), con el activo marcado.
- **Panel de runtime**: modelo, host, contexto, temperatura y estado de los
  overrides de prompt.
- **Conversaciones** persistidas en `localStorage`, con lista lateral y borrado.
- **Render de código**: fences ```lang, `inline`, **negrita** y saltos de línea.

## 📡 API consumida

La UI no asume nada del backend más allá de estos endpoints (proyecto Aether,
`backend/api/main.py`):

| Endpoint | Método | Uso |
|---|---|---|
| `/api/health` | GET | Estado del API y de Ollama (status card). |
| `/api/status` | GET | Modelo activo, host, `NUM_CTX`, `TEMPERATURE`, flags del prompt. |
| `/api/chat/stream` | POST | Chat con streaming SSE (`token`, `node`, `log`, `done`, `error`). |
| `/api/stop` | POST | Aborta la generación en curso. |
| `/api/config` | GET / POST | Lee/guarda la config de la TUI (misma validación que `ConfigManager`). |
| `/api/system-prompt` | GET / POST | Lee/guarda las 3 claves del system prompt. |
| `/api/system-prompt/preview` | GET | Prompt final ya compuesto (`core/agent/prompts.py`). |
| `/api/models` | GET / POST | Lista los modelos de Ollama y cambia el activo. |

## 🚀 Cómo se sirve

El backend de Aether sirve esta carpeta como estático. Orden de resolución en
`backend/core/config.py` → `resolver_web_ui_dir()`:

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