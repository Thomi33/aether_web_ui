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