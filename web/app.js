/* ══════════════════════════════════════════════════════════════════════
 * Aether Web UI — app.js
 * Chat con streaming real (SSE) contra el backend FastAPI + panel de
 * configuración (la misma config.json que la TUI) + system prompt editable.
 * ══════════════════════════════════════════════════════════════════════ */
"use strict";

const $ = (id) => document.getElementById(id);

/* Base de la API. Vacío = mismo origen (el backend sirve esta carpeta).
   En desarrollo con un servidor estático aparte (serve.sh) se inyecta
   window.AETHER_API_BASE = "http://localhost:8000". */
const API_BASE = (window.AETHER_API_BASE || "").replace(/\/+$/, "");

/* ── Estado ── */
let conversaciones = [];
let convActual = null;
let streamingActivo = false;
let abortStream = null;

const LS_KEY = "aether_webui_convs";

/* ══════════════════════════ Utilidades ══════════════════════════ */

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
  t.className = ok ? "toast-ok" : "toast-err";
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(path, opts) {
  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (!resp.ok && !(opts && opts._sse)) throw new Error(`HTTP ${resp.status}`);
  return resp;
}

/* ══════════════════════════ Conversaciones ══════════════════════════ */

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

function pintarConvList() {
  const ul = $("conv-list");
  ul.innerHTML = "";
  for (const c of conversaciones) {
    const li = document.createElement("li");
    li.textContent = c.title;
    li.className = c === convActual ? "active" : "";
    li.title = c.title;
    li.onclick = () => {
      convActual = c;
      pintarConvList();
      pintarMensajes();
    };
    ul.appendChild(li);
  }
  if (!conversaciones.length) {
    ul.innerHTML = '<li class="muted">(sin conversaciones)</li>';
  }
}

function pintarMensajes() {
  const box = $("messages");
  box.innerHTML = "";
  const msgs = (convActual && convActual.messages) || [];
  if (!msgs.length) {
    box.innerHTML = `<div class="welcome">
      <div class="welcome-logo"></div>
      <h2>Hola, soy Aether</h2>
      <p class="muted">Tu agente local. Preguntame lo que quieras — corre en tu máquina,
      con tu configuración y tu memoria.</p>
    </div>`;
  }
  for (const m of msgs) agregarBurbuja(m.role, m.text, false);
  box.scrollTop = box.scrollHeight;
}

function agregarBurbuja(role, text, scroll = true) {
  const box = $("messages");
  const wel = box.querySelector(".welcome");
  if (wel) wel.remove();
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.innerHTML =
    `<div class="msg-avatar">${role === "user" ? "TÚ" : "AE"}</div>` +
    `<div class="msg-body">${renderTexto(text)}</div>`;
  box.appendChild(div);
  if (scroll) box.scrollTop = box.scrollHeight;
  return div;
}

function tituloDe(texto) {
  const t = texto.trim().replace(/\s+/g, " ");
  return t.length > 40 ? `${t.slice(0, 40)}…` : (t || "Nueva conversación");
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
  }
}

async function enviar() {
  const input = $("input");
  const texto = input.value.trim();
  if (!texto || streamingActivo) return;
  input.value = "";
  autoResize();

  if (!convActual) nuevaConversacion(true);
  if (convActual.title === "Nueva conversación") {
    convActual.title = tituloDe(texto);
    $("chat-title").textContent = convActual.title;
  }

  convActual.messages.push({ role: "user", text: texto });
  agregarBurbuja("user", texto);
  persistirConvs();
  pintarConvList();
  setBusy(true);

  const burbuja = agregarBurbuja("assistant", "…");
  const bodyEl = burbuja.querySelector(".msg-body");
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
            bodyEl.innerHTML = renderTexto(acumulado);
            $("messages").scrollTop = $("messages").scrollHeight;
          } else if (ev.type === "node") {
            setActividad(`nodo: ${ev.node}`);
          } else if (ev.type === "log") {
            const log = $("activity-log");
            log.hidden = false;
            log.textContent = ev.data.slice(0, 160);
          } else if (ev.type === "done") {
            acumulado = ev.response || acumulado || "Operación completada.";
            bodyEl.innerHTML = renderTexto(acumulado);
          } else if (ev.type === "error") {
            acumulado = `⚠️ ${ev.message}`;
            burbuja.classList.add("msg-error");
            bodyEl.innerHTML = renderTexto(acumulado);
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      acumulado += "\n\n⏹ *cancelado*";
    } else {
      acumulado = `⚠️ Sin conexión con el backend: ${err.message}`;
      burbuja.classList.add("msg-error");
    }
    bodyEl.innerHTML = renderTexto(acumulado);
  } finally {
    convActual.messages.push({ role: "assistant", text: acumulado });
    persistirConvs();
    setBusy(false);
    abortStream = null;
    refrescarStatus();
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
    $("status-dot").className = `status-dot ${online ? "on" : "off"}`;
    $("status-text").textContent = online ? "online" : (st.status || "offline");
    $("rt-dot").className = `rt-dot ${online ? "on" : "off"}`;
    $("rt-sub").textContent = online ? "Motor LangGraph listo" : "inicializando…";
    $("status-model").textContent = st.model || "—";
    $("status-host").textContent = st.ollama || "—";
    $("rt-model").textContent = st.model || "—";
    $("rt-host").textContent = st.ollama || "—";
    $("rt-mem").textContent = (st.memory_size ?? "—");
    $("rt-version").textContent = st.version || "—";
    $("chat-sub").textContent = `Local · ${st.model || "—"}`;
  } catch {
    $("status-dot").className = "status-dot off";
    $("status-text").textContent = "backend offline";
    $("rt-dot").className = "rt-dot off";
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
      toast("Configuración aplicada (config.json) — la TUI la ve al arrancar");
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
$("btn-new-chat").addEventListener("click", () => nuevaConversacion());
$("btn-settings").addEventListener("click", abrirSettings);
$("btn-models").addEventListener("click", () => {
  cargarModelos();
  toast("Modelos actualizados");
});
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
refrescarStatus();
setInterval(refrescarStatus, 6000);
