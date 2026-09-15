/* ══════════════════════════════════════════════════════════════════════
 * Aether Web UI — app.js
 * Interfaz web con PARIDAD de features con la TUI (tui/app.py), hablando
 * con el backend FastAPI (mismo motor LangGraph del runtime):
 *
 * - Chat con streaming real (SSE): tokens en vivo.
 * - Chip de actividad con ESTADO HUMANO (mismo mapa que status_messages).
 * - Panel ACTIVIDAD: plan de ejecución + líneas de trabajo en vivo
 *   (port de tui/widgets/plan_panel.py).
 * - Panel LOGS: stdout del motor en vivo (port del DebugPanel de la TUI).
 * - Sesiones del runtime (memoria.db): listar y abrir historiales reales,
 *   además de las conversaciones locales del navegador.
 * - Config de la TUI (config.json), system prompt editable y selector de
 *   modelos — mismas validaciones que la TUI.
 *
 * FIXES de la auditoría (bug fuerte de render):
 * - Clases de burbuja: .msg.user / .msg.assistant (antes msg-user ≠ CSS).
 * - Contenido dentro de .msg-content (antes iba suelto en .msg-body y el
 *   CSS de burbujas/fondos/código nunca aplicaba).
 * - Errores: clase .error (antes msg-error, inexistente en el CSS).
 * - Dots de estado: online/offline/busy (antes on/off, inexistentes).
 * - Toasts de error: #toast.error (antes toast-ok/toast-err).
 * ══════════════════════════════════════════════════════════════════════ */
"use strict";

const $ = (id) => document.getElementById(id);

/* Base de la API. Vacío = mismo origen (el backend sirve esta carpeta).
   En desarrollo con un servidor estático aparte (serve.sh) se inyecta
   window.AETHER_API_BASE = "http://localhost:8000". */
const API_BASE = (window.AETHER_API_BASE || "").replace(/\/+$/, "");

/* ── Estado ── */
let conversaciones = [];     // persistidas en localStorage (navegador)
let convActual = null;
let sesionVista = null;      // sesión del runtime abierta en modo lectura
let sesiones = [];           // cache de /api/sessions (historial real)
let streamingActivo = false;
let abortStream = null;

const LS_KEY = "aether_webui_convs";

/* ══════════════════════════ Utilidades ══════════════════════════ */

const RE_ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (s) => String(s ?? "").replace(RE_ANSI, "");

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderTexto(s) {
  /* Markdown mínimo: fences de código, **negrita**, `inline` y saltos. */
  let html = escapeHtml(s);
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g,
    (_, lang, code) => `<pre class="code${lang ? ` lang-${lang}` : ""}"><code>${code}</code></pre>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return html.replace(/\n/g, "<br>");
}

function toast(msg, ok = true) {
  const t = $("toast");
  t.textContent = msg;
  t.className = ok ? "" : "error";   // FIX: el CSS solo tiene #toast.error
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(path, opts) {
  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (!resp.ok && !(opts && opts._sse)) throw new Error(`HTTP ${resp.status}`);
  return resp;
}

/* ══════════════════════════ Conversaciones (localStorage) ══════════ */

function cargarConvs() {
  try { conversaciones = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { conversaciones = []; }
}

function persistirConvs() {
  localStorage.setItem(LS_KEY, JSON.stringify(conversaciones.slice(0, 50)));
}

function nuevaConversacion(silencio = false) {
  convActual = {
    id: Date.now().toString(36),
    title: "Nueva conversación",
    messages: [],
    createdAt: new Date().toISOString(),
  };
  conversaciones.unshift(convActual);
  persistirConvs();
  pintarConvList();
  pintarMensajes();
  if (!silencio) toast("Nueva conversación");
}

function borrarConversacion(id) {
  conversaciones = conversaciones.filter((c) => c.id !== id);
  if (convActual && convActual.id === id) convActual = null;
  persistirConvs();
  pintarConvList();
  if (!convActual) nuevaConversacion(true);
  else pintarMensajes();
}

function pintarConvList() {
  const ul = $("conv-list");
  ul.innerHTML = "";
  for (const c of conversaciones) {
    const li = document.createElement("li");
    li.className = (!sesionVista && c === convActual) ? "active" : "";
    li.title = c.title;
    li.innerHTML =
      `<span class="conv-title">${escapeHtml(c.title)}</span>` +
      `<span class="del" title="Borrar conversación">✕</span>`;
    li.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      borrarConversacion(c.id);
    });
    li.addEventListener("click", () => {
      sesionVista = null;
      convActual = c;
      pintarConvList();
      pintarSessionList();
      pintarMensajes();
    });
    ul.appendChild(li);
  }
  if (!conversaciones.length) {
    ul.innerHTML = '<li class="muted">(sin conversaciones)</li>';
  }
}

function _mensajesActivos() {
  if (sesionVista) return sesionVista.messages;
  return (convActual && convActual.messages) || [];
}

function pintarMensajes() {
  const box = $("messages");
  box.innerHTML = "";
  const msgs = _mensajesActivos();
  if (!msgs.length) {
    box.innerHTML = `<div class="welcome">
      <div class="welcome-logo"></div>
      <h2>Hola, soy Aether</h2>
      <p class="muted">Tu agente local. Preguntame lo que quieras — corre en tu máquina,
      con tu configuración y tu memoria.</p>
    </div>`;
  }
  for (const m of msgs) agregarBurbuja(m.role, m.text, false, m.fecha);

  $("chat-title").textContent = sesionVista
    ? `${sesionVista.title} (sesión, solo lectura)`
    : ((convActual && convActual.title) || "Nueva conversación");
  box.scrollTop = box.scrollHeight;
}

function agregarBurbuja(role, text, scroll = true, fecha = "") {
  const box = $("messages");
  const wel = box.querySelector(".welcome");
  if (wel) wel.remove();
  const div = document.createElement("div");
  // FIX principal: .msg.user / .msg.assistant (matchea el CSS) y el texto
  // va dentro de .msg-content (donde el CSS aplica fondo/borde/código).
  div.className = `msg ${role}`;
  const hora = fecha || new Date().toLocaleTimeString("es-UY", { hour: "2-digit", minute: "2-digit" });
  div.innerHTML =
    `<div class="msg-avatar">${role === "user" ? "TÚ" : "AE"}</div>` +
    `<div class="msg-body">` +
      `<div class="msg-meta"><span class="who">${role === "user" ? "Vos" : "Aether"}</span>` +
      `<span>${escapeHtml(hora)}</span></div>` +
      `<div class="msg-content">${renderTexto(text)}</div>` +
    `</div>`;
  box.appendChild(div);
  if (scroll) box.scrollTop = box.scrollHeight;
  return div;
}

function tituloDe(texto) {
  const t = texto.trim().replace(/\s+/g, " ");
  return t.length > 40 ? `${t.slice(0, 40)}…` : (t || "Nueva conversación");
}

/* ════════════ Panel ACTIVIDAD (port de tui/widgets/plan_panel.py) ════
   Consume el delta de los eventos "node" del SSE (/api/chat/stream). */

const ICONOS_TOOL = {
  text: "💬", web: "🔍", shell: "🖥️", launch: "🚀",
  vision: "👁️", codigo: "💻", memory: "🧩",
  file_write: "💾", extract: "🧹", mcp: "🔌",
  computer_use: "🖱️",
  fs_write: "💾", fs_read: "📖", fs_mkdir: "📁", fs_list: "📂",
};

const ETIQUETAS_TOOL = {
  fs_write: "Escribiendo archivo", fs_read: "Leyendo archivo",
  fs_mkdir: "Creando carpeta", fs_list: "Listando carpeta",
  file_write: "Guardando archivo", shell: "Ejecutando comando",
  codigo: "Generando código", web: "Buscando en la web",
  vision: "Analizando pantalla", mcp: "Llamando MCP",
  computer_use: "Controlando interfaz", launch: "Abriendo app",
  memory: "Gestionando memoria", text: "Respondiendo",
};

function resumirArgs(args) {
  if (!args || typeof args !== "object") return "";
  const files = args.files;
  if (Array.isArray(files) && files.length) {
    const rutas = files.slice(0, 3).map((f) =>
      String((f && (f.path || f.filename)) || "?"));
    const extra = files.length > 3 ? ` (+${files.length - 3} más)` : "";
    return `${files.length} archivos: ${rutas.join(", ")}${extra}`;
  }
  for (const clave of ["path", "filename", "command", "query", "app", "instruccion"]) {
    const val = args[clave];
    if (typeof val === "string" && val.trim()) {
      const v = val.trim();
      return v.length > 80 ? v.slice(0, 80) + "…" : v;
    }
  }
  return "";
}

function lineaDePaso(tool, args, resultado) {
  const icono = ICONOS_TOOL[tool] || "•";
  const etiqueta = ETIQUETAS_TOOL[tool] || tool;
  const detalle = resumirArgs(args);
  let linea = `${icono} ${etiqueta}`;
  if (detalle) linea += ` → ${detalle}`;
  if (typeof resultado === "string" && resultado.trim()) {
    let primera = resultado.trim().split("\n", 1)[0];
    if (primera.length > 90) primera = primera.slice(0, 90) + "…";
    if (tool === "fs_read") {
      linea += ` (${resultado.length} caracteres)`;
    } else if (tool === "fs_list") {
      const n = resultado.trim().split("\n").filter((l) => l.trim()).length;
      linea += ` (${n} entradas)`;
    } else {
      linea += ` — ${primera}`;
    }
  } else if (tool === "fs_read" && typeof resultado === "string") {
    linea += ` (${resultado.length} caracteres)`;
  }
  return linea;
}

const planState = {
  pasos: [], index: 0, activo: false, actividad: [], firmas: new Set(),
};
const MAX_ACTIVIDAD = 8;

function resetPlanTurno() {
  planState.pasos = [];
  planState.index = 0;
  planState.activo = false;
  planState.actividad = [];
  planState.firmas = new Set();
  repintarPlan();
}

function agregarActividad(linea) {
  linea = stripAnsi(linea).trim();
  if (!linea) return;
  if (planState.actividad[planState.actividad.length - 1] === linea) return;
  planState.actividad.push(linea);
  if (planState.actividad.length > MAX_ACTIVIDAD) {
    planState.actividad = planState.actividad.slice(-MAX_ACTIVIDAD);
  }
}

function actualizarPlanDelta(nodo, delta) {
  if (!delta || typeof delta !== "object") return;
  const key = (nodo || "").split(".").pop();

  if (key === "planner") {
    if (Array.isArray(delta.plan_pasos)) planState.pasos = delta.plan_pasos;
    if (Number.isInteger(delta.plan_index)) planState.index = delta.plan_index;
    if (typeof delta.plan_activo === "boolean") planState.activo = delta.plan_activo;
    repintarPlan();
    return;
  }

  if (key === "plan_executor") {
    const tool = delta.tool_actual || delta.herramienta || "?";
    let args = {};
    try {
      const idx = (Number.isInteger(delta.plan_index) ? delta.plan_index : 0) - 1;
      const paso = planState.pasos[idx];
      if (paso && typeof paso === "object") args = paso.args || {};
    } catch { /* noop */ }
    let resultado = delta.fs_result || delta.shell_output || "";
    if (typeof resultado === "string" && resultado.length > 400) {
      resultado = resultado.slice(0, 400);
    }
    agregarActividad(lineaDePaso(String(tool), args, resultado));
    if (Number.isInteger(delta.plan_index)) planState.index = delta.plan_index;
    repintarPlan();
    return;
  }

  if (key === "agent_loop") {
    const pasos = delta.agent_pasos_log;
    if (Array.isArray(pasos)) {
      for (const paso of pasos) {
        if (!paso || typeof paso !== "object") continue;
        const firma = `${paso.tool}|${JSON.stringify(paso.args)}|${String(paso.resultado || "").slice(0, 80)}`;
        if (planState.firmas.has(firma)) continue;
        planState.firmas.add(firma);
        agregarActividad(lineaDePaso(String(paso.tool || "?"), paso.args || {}, paso.resultado || ""));
      }
      if (planState.firmas.size > 64) {
        planState.firmas = new Set([...planState.firmas].slice(-64));
      }
      repintarPlan();
    }
    return;
  }

  if (Array.isArray(delta.plan_pasos)) {
    planState.pasos = delta.plan_pasos;
    repintarPlan();
  }
}

function repintarPlan() {
  const panel = $("plan-panel");
  const ulPasos = $("plan-steps");
  const ulAct = $("activity-lines");
  const hayPasos = planState.pasos.length > 0;
  const hayAct = planState.actividad.length > 0;
  const planificando = planState.activo && !hayPasos;

  panel.hidden = !(hayPasos || hayAct || planificando) || !streamingActivo;

  ulPasos.innerHTML = "";
  planState.pasos.forEach((paso, i) => {
    const tool = (paso && typeof paso === "object") ? String(paso.tool || "?") : String(paso);
    const icono = ICONOS_TOOL[tool] || "•";
    const completado = (i + 1) <= planState.index;
    const li = document.createElement("li");
    li.className = completado ? "completado"
      : ((i + 1) === planState.index + 1 && planState.activo ? "en-curso" : "pendiente");
    li.innerHTML = `<span class="paso-check">${completado ? "✓" : "○"}</span>${icono} ${escapeHtml(tool)}`;
    ulPasos.appendChild(li);
  });
  if (planificando) {
    const li = document.createElement("li");
    li.className = "pendiente";
    li.textContent = "planificando…";
    ulPasos.appendChild(li);
  }

  ulAct.innerHTML = "";
  for (const linea of planState.actividad) {
    const li = document.createElement("li");
    li.textContent = linea;
    ulAct.appendChild(li);
  }
}

/* ════════════ Panel LOGS (port del DebugPanel de la TUI) ════════════ */

const LOG_MAX = 250;
let logTotal = 0;

function agregarLogLinea(texto, esError = false) {
  const limpio = stripAnsi(texto).trim();
  if (!limpio) return;
  const box = $("log-lines");
  const div = document.createElement("div");
  div.className = "log-line" + (esError ? " error" : "");
  div.textContent = limpio;
  box.appendChild(div);
  while (box.childElementCount > LOG_MAX) box.removeChild(box.firstChild);
  logTotal += 1;
  $("log-count").textContent = String(logTotal);
  box.scrollTop = box.scrollHeight;
}

/* ═══════════ Sesiones del runtime (memoria.db — como /sesiones de la TUI) ═ */

async function cargarSesiones() {
  try {
    const r = await (await api("/api/sessions")).json();
    sesiones = r.ok ? (r.sessions || []) : [];
  } catch {
    sesiones = [];
  }
  pintarSessionList();
}

function pintarSessionList() {
  const ul = $("session-list");
  ul.innerHTML = "";
  $("sesiones-count").textContent = sesiones.length ? `${sesiones.length}` : "";
  for (const s of sesiones) {
    const li = document.createElement("li");
    li.title = `${s.inicio}\n${s.turnos} turnos`;
    if (sesionVista && sesionVista.id === s.sesion_id) li.classList.add("active");
    const fecha = String(s.inicio || "").slice(5, 16);
    const preview = s.preview || "(sin mensajes de usuario)";
    li.innerHTML =
      `<span class="ses-meta">[${escapeHtml(fecha)}]</span> ${escapeHtml(preview)}`;
    li.addEventListener("click", () => abrirSesion(s.sesion_id));
    ul.appendChild(li);
  }
  if (!sesiones.length) {
    ul.innerHTML = '<li class="muted">(sin sesiones)</li>';
  }
}

async function abrirSesion(id) {
  try {
    const r = await (await api(`/api/sessions/${encodeURIComponent(id)}`)).json();
    if (!r.ok) throw new Error(r.error || "fallo al cargar la sesión");
    const s = sesiones.find((x) => x.sesion_id === id);
    sesionVista = {
      id,
      title: s && s.preview ? tituloDe(s.preview) : `Sesión ${id}`,
      messages: r.messages || [],
    };
    pintarMensajes();
    pintarSessionList();
    pintarConvList();
  } catch (err) {
    toast(`No se pudo abrir la sesión: ${err.message}`, false);
  }
}

/* ══════════════════════════ Chat con streaming ══════════════════════════ */

function setBusy(on) {
  streamingActivo = on;
  $("busy-chip").hidden = !on;
  $("btn-stop").hidden = !on;
  $("btn-send").disabled = on;
  $("input").disabled = on;
  if (!on) {
    $("activity-chip").hidden = true;
    $("activity-log").hidden = true;
    $("plan-panel").hidden = true;
  }
}

async function enviar() {
  const input = $("input");
  const texto = input.value.trim();
  if (!texto || streamingActivo) return;

  /* Si se estaba viendo una sesión archivada del runtime (solo lectura),
     el nuevo mensaje inicia una conversación nueva — igual que la TUI:
     la sesión vieja queda disponible para consulta. */
  if (sesionVista) {
    sesionVista = null;
    nuevaConversacion(true);
  }

  input.value = "";
  autoResize();

  if (!convActual) nuevaConversacion(true);
  if (convActual.title === "Nueva conversación") {
    convActual.title = tituloDe(texto);
  }

  convActual.messages.push({ role: "user", text: texto });
  agregarBurbuja("user", texto);
  persistirConvs();
  pintarConvList();
  pintarMensajes();  // refresca el título del chat

  resetPlanTurno();
  setBusy(true);

  const burbuja = agregarBurbuja("assistant", "…");
  const contentEl = burbuja.querySelector(".msg-content");
  let acumulado = "";

  const setActividad = (t) => {
    $("activity-chip").hidden = false;
    $("activity-text").textContent = t;
  };

  try {
    abortStream = new AbortController();
    const resp = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: texto }),
      signal: abortStream.signal,
      _sse: true,
    });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const crudo = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const linea of crudo.split("\n")) {
          if (!linea.startsWith("data: ")) continue;
          const data = linea.slice(6);
          if (data === "[DONE]") continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }

          if (ev.type === "token") {
            acumulado += ev.data;
            contentEl.innerHTML = renderTexto(acumulado);
            $("messages").scrollTop = $("messages").scrollHeight;
          } else if (ev.type === "node") {
            /* Estado humano (mismo mapa que la TUI, lo arma el backend). */
            setActividad(ev.estado || `nodo: ${ev.node}`);
            actualizarPlanDelta(ev.node, ev.delta);
          } else if (ev.type === "log") {
            agregarLogLinea(ev.data);
            const log = $("activity-log");
            log.hidden = false;
            log.textContent = ev.data.slice(0, 160);
          } else if (ev.type === "done") {
            /* Ya viene limpia del backend (limpiar_respuesta_chat, la misma
               función que usa la TUI para su respuesta final). */
            acumulado = ev.response || acumulado || "Operación completada.";
            contentEl.innerHTML = renderTexto(acumulado);
          } else if (ev.type === "error") {
            acumulado = `⚠️ ${ev.message}`;
            burbuja.classList.add("error");  // FIX: clase .error (existe en CSS)
            contentEl.innerHTML = renderTexto(acumulado);
            agregarLogLinea(ev.message, true);
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      acumulado += "\n\n⏹ *cancelado*";
    } else {
      acumulado = `⚠️ Sin conexión con el backend: ${err.message}`;
      burbuja.classList.add("error");
      agregarLogLinea(`Error de conexión: ${err.message}`, true);
    }
    contentEl.innerHTML = renderTexto(acumulado);
  } finally {
    convActual.messages.push({ role: "assistant", text: acumulado });
    persistirConvs();
    setBusy(false);
    abortStream = null;
    refrescarStatus();
    /* La respuesta ya quedó registrada en memoria: refrescar sesiones. */
    cargarSesiones();
  }
}

function autoResize() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

/* ══════════════════════════ Status / modelos / runtime ══════════════ */

async function refrescarStatus() {
  try {
    const st = await (await api("/api/status")).json();
    const online = st.agent_status === "online" || st.status === "ready";
    /* FIX: el CSS define .online / .offline / .busy (antes se usaban
       clases inexistentes on/off y el dot quedaba siempre gris). */
    const dotCls = st.busy ? "busy" : (online ? "online" : "offline");
    $("status-dot").className = `status-dot ${dotCls}`;
    $("status-text").textContent = st.busy ? "ocupado" : (online ? "online" : (st.status || "offline"));
    $("rt-dot").className = `rt-dot ${dotCls}`;
    $("rt-sub").textContent = st.busy
      ? "Procesando una orden…"
      : (online ? "Motor LangGraph listo" : "inicializando…");
    $("status-model").textContent = st.model || "—";
    $("status-host").textContent = st.ollama || "—";
    $("rt-model").textContent = st.model || "—";
    $("rt-host").textContent = st.ollama || "—";
    $("rt-mem").textContent = (st.memory_size ?? "—");
    $("rt-version").textContent = st.version || "—";
    if (!sesionVista) $("chat-sub").textContent = `Local · ${st.model || "—"}`;
  } catch {
    $("status-dot").className = "status-dot offline";
    $("status-text").textContent = "backend offline";
    $("rt-dot").className = "rt-dot offline";
  }
  try {
    const r = await (await api("/api/config")).json();
    if (r.config) {
      $("rt-ctx").textContent = r.config.NUM_CTX ?? "—";
      $("rt-temp").textContent = r.config.TEMPERATURE ?? "—";
      $("rt-sp-override").textContent = activo(r.config.SYSTEM_PROMPT_OVERRIDE);
      $("rt-sp-extra").textContent = activo(r.config.SYSTEM_PROMPT_EXTRA);
      $("rt-sp-sintesis").textContent = activo(r.config.SYSTEM_PROMPT_SINTESIS_EXTRA);
    }
  } catch { /* el panel queda con — */ }
}

const activo = (v) => (((v ?? "") + "").trim() ? "ACTIVO" : "off");

async function cargarModelos() {
  const sel = $("model-select");
  try {
    const data = await (await api("/api/models")).json();
    sel.innerHTML = "";
    if (!data.models || !data.models.length) {
      sel.innerHTML = '<option value="">(sin modelos en Ollama)</option>';
      return;
    }
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name + (m.active ? "  ●" : "");
      if (m.active) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {
    sel.innerHTML = '<option value="">(backend offline)</option>';
  }
}

/* Cambiar modelo desde la Web UI = mismo MODELO de config.json que usa la TUI. */
$("model-select").addEventListener("change", async (e) => {
  const modelo = e.target.value;
  if (!modelo) return;
  try {
    const r = await (await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "MODELO", value: modelo }),
    })).json();
    toast(r.ok ? `Modelo activo: ${modelo}` : "Validación rechazó el modelo", r.ok);
    refrescarStatus();
    cargarModelos();  // re-marcar el activo
  } catch (err) { toast(`Error: ${err.message}`, false); }
});

/* ══════════════════════════ Settings: config TUI ═════════════════════ */

const CFG_FIELDS = [
  "OLLAMA_HOST", "SEARXNG_URL", "TEMPERATURE", "MAX_TOKENS", "NUM_PREDICT",
  "NUM_CTX", "TIMEOUT_CMD", "MAX_TURNOS_CONTEXTO",
];
const CFG_CHECKS = ["MODO_AUTONOMO", "TOOL_CALLING_NATIVO"];
const CFG_NUMERICAS = new Set([
  "TEMPERATURE", "MAX_TOKENS", "NUM_PREDICT", "NUM_CTX",
  "TIMEOUT_CMD", "MAX_TURNOS_CONTEXTO",
]);

async function cargarConfigUI() {
  try {
    const r = await (await api("/api/config")).json();
    if (!r.config) return;
    for (const k of CFG_FIELDS) {
      const el = $(`cfg-${k}`);
      if (el) el.value = r.config[k] ?? "";
    }
    for (const k of CFG_CHECKS) {
      const el = $(`cfg-${k}`);
      if (el) el.checked = !!r.config[k];
    }
  } catch { toast("No se pudo cargar la configuración", false); }
}

async function guardarConfigTUI() {
  const values = {};
  for (const k of CFG_FIELDS) {
    const raw = $(`cfg-${k}`).value;
    if (raw === "") continue;
    values[k] = CFG_NUMERICAS.has(k)
      ? (k === "TEMPERATURE" ? parseFloat(raw) : parseInt(raw, 10))
      : raw;
  }
  for (const k of CFG_CHECKS) values[k] = $(`cfg-${k}`).checked;

  const st = $("tui-save-status");
  try {
    const r = await (await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    })).json();
    const fallidas = Object.entries(r.results || {})
      .filter(([, v]) => !v).map(([k]) => k);
    if (r.ok) {
      st.textContent = "✅ guardado";
      toast("Configuración aplicada (config.json) — vale desde el próximo turno");
    } else {
      st.textContent = `⚠️ falló: ${fallidas.join(", ")}`;
      toast(`Validación rechazó: ${fallidas.join(", ")}`, false);
    }
    refrescarStatus();
  } catch (err) {
    st.textContent = `❌ ${err.message}`;
    toast(`Error: ${err.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 4000);
  }
}

/* ══════════════════════════ Settings: system prompt ══════════════════ */

async function cargarSystemPrompt() {
  try {
    const sp = await (await api("/api/system-prompt")).json();
    $("sp-override").value = sp.override ?? "";
    $("sp-extra").value = sp.extra ?? "";
    $("sp-sintesis").value = sp.sintesis_extra ?? "";
  } catch { toast("No se pudo cargar el system prompt", false); }
}

async function guardarSystemPrompt() {
  const body = {
    override: $("sp-override").value,
    extra: $("sp-extra").value,
    sintesis_extra: $("sp-sintesis").value,
  };
  const st = $("prompt-save-status");
  try {
    const r = await (await api("/api/system-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
    st.textContent = r.ok ? "✅ guardado" : "⚠️ error al validar";
    toast(r.ok ? "System prompt aplicado — vale desde el próximo turno"
              : "No se pudo guardar el system prompt", r.ok);
    refrescarStatus();
  } catch (err) {
    st.textContent = `❌ ${err.message}`;
    toast(`Error: ${err.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 4000);
  }
}

async function previewSystemPrompt() {
  const box = $("prompt-preview");
  box.hidden = false;
  box.textContent = "generando preview…";
  try {
    const r = await (await api("/api/system-prompt/preview")).json();
    box.textContent =
      `── SYSTEM PROMPT (ejecución) ──\n${r.backstory}\n\n` +
      `── PERSONA SÍNTESIS ──\n${r.persona_sintesis}`;
  } catch (err) {
    box.textContent = `Error: ${err.message}`;
  }
}

/* ══════════════════════════ Modal settings ══════════════════════════ */

function abrirSettings() {
  $("settings-modal").hidden = false;
  cargarConfigUI();
  cargarSystemPrompt();
}
function cerrarSettings() { $("settings-modal").hidden = true; }

document.querySelectorAll(".modal-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".modal-tabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-body").forEach((b) => { b.hidden = true; });
    $(tab.dataset.tab).hidden = false;
  });
});

/* ══════════════════════════ Wiring inicial ══════════════════════════ */

$("btn-send").addEventListener("click", enviar);
$("btn-stop").addEventListener("click", async () => {
  try {
    await fetch(`${API_BASE}/api/stop`, { method: "POST" });
    toast("Cancelando inferencia…");
  } catch { /* igual abortamos localmente */ }
  if (abortStream) abortStream.abort();
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
});
$("input").addEventListener("input", autoResize);
$("btn-new-chat").addEventListener("click", () => {
  sesionVista = null;
  pintarSessionList();
  nuevaConversacion();
});
$("btn-settings").addEventListener("click", abrirSettings);
$("btn-models").addEventListener("click", () => {
  cargarModelos();
  toast("Modelos actualizados");
});
$("btn-refresh-sessions").addEventListener("click", cargarSesiones);
$("btn-close-settings").addEventListener("click", cerrarSettings);
$("settings-modal").addEventListener("click", (e) => {
  if (e.target === $("settings-modal")) cerrarSettings();
});
$("btn-save-tui").addEventListener("click", guardarConfigTUI);
$("btn-save-prompt").addEventListener("click", guardarSystemPrompt);
$("btn-preview-prompt").addEventListener("click", previewSystemPrompt);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cerrarSettings();
});

/* ── Arranque ── */
cargarConvs();
if (!conversaciones.length) nuevaConversacion(true);
convActual = conversaciones[0];
pintarConvList();
pintarMensajes();
cargarModelos();
cargarSesiones();
refrescarStatus();
setInterval(refrescarStatus, 6000);
setInterval(cargarSesiones, 30000);
