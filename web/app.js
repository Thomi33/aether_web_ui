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
 * - Workspace modal: Proyectos (~/Aether/proyectos.json), Memoria (resumen
 *   rolling summary + recuerdos, como /memory), Skills (SKILL.md por carpeta),
 *   Tareas (~/Aether/tareas.json), MCPs (mcp_servers.json + alta custom),
 *   Roblox (/play-roblox) y Effort & Agente (/effort, /agents de la TUI).
 * - Adjuntos [+]: imágenes y archivos en base64; el backend los guarda en
 *   ~/Aether/adjuntos y compone la orden (texto embebido, imágenes descritas
 *   con el modelo de visión).
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

/* Íconos lucide: icons.js embebe los glifos del paquete npm lucide-react.
   ICO devuelve markup <svg> para insertar en template literals; cae a ""
   (sin glifo) si icons.js no llegó a cargar. */
const ICO = (name, cls) => (window.LUCIDE ? window.LUCIDE.icon(name, cls) : "");

/* ── Estado ── */
let conversaciones = [];     // persistidas en localStorage (navegador)
let convActual = null;
let sesionVista = null;      // sesión del runtime abierta en modo lectura
let sesiones = [];           // cache de /api/sessions (historial real)
let streamingActivo = false;
let abortStream = null;
let adjuntos = [];           // adjuntos pendientes (imágenes/archivos)

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

function esConversacionVacia(c) {
  return !!(c && c.title === "Nueva conversación"
            && Array.isArray(c.messages) && c.messages.length === 0);
}

function nuevaConversacion(silencio = false) {
  // Reusar la conversación vacía existente en vez de acumular "Nueva
  // conversación" sin título ni mensajes una tras otra en el sidebar.
  if (esConversacionVacia(convActual)) {
    sesionVista = null;
    pintarConvList();
    pintarMensajes();
    if (!silencio) toast("Ya tenés una conversación vacía: seguí escribiendo acá");
    return convActual;
  }
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
  return convActual;
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
      `<span class="del" title="Borrar conversación">${ICO("x")}</span>`;
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
  for (const m of msgs) agregarBurbuja(m.role, m.text, false, m.fecha, m.attachments, m.reasoning || "");

  $("chat-title").textContent = sesionVista
    ? `${sesionVista.title} (sesión, solo lectura)`
    : ((convActual && convActual.title) || "Nueva conversación");
  box.scrollTop = box.scrollHeight;
}

function renderAdjuntosHTML(atts) {
  /* Adjuntos dentro de una burbuja: imágenes como thumbnails. Orden de
     resolución del src: dataURL vivo (recién subida) → endpoint del
     backend por path (persistido con el mensaje desde el upload) →
     endpoint por nombre (mensajes viejos que solo guardaron el nombre).
     Si el archivo ya no existe, agregarBurbuja degrada la img a chip. */
  if (!atts || !atts.length) return "";
  const partes = atts.map((a) => {
    if (a.kind === "image") {
      let src = "";
      if (a.url) {
        src = a.url;
      } else if (a.data && a.data.startsWith("data:")) {
        // dataURL vivo (recién subida, base64)
        src = a.data;
      } else if (a.path) {
        src = `${API_BASE}/api/attachments/file?path=${encodeURIComponent(a.path)}&thumb=1`;
      } else if (a.name) {
        src = `${API_BASE}/api/attachments/file?name=${encodeURIComponent(a.name)}&thumb=1`;
      }
      if (src) {
        return `<img src="${src}" alt="${escapeHtml(a.name)}" title="${escapeHtml(a.name)}" loading="lazy">`;
      }
    }
    const icon = a.kind === "image" ? ICO("image")
      : (a.kind === "text" ? ICO("file-text") : ICO("file"));
    return `<span class="msg-file">${icon} ${escapeHtml(a.name)}</span>`;
  });
  return `<div class="msg-attachments">${partes.join("")}</div>`;
}

function agregarBurbuja(role, text, scroll = true, fecha = "", atts = null, reasoning = "") {
  const box = $("messages");
  const wel = box.querySelector(".welcome");
  if (wel) wel.remove();
  const div = document.createElement("div");
  // FIX principal: .msg.user / .msg.assistant (matchea el CSS) y el texto
  // va dentro de .msg-content (donde el CSS aplica fondo/borde/código).
  div.className = `msg ${role}`;
  const hora = fecha || new Date().toLocaleTimeString("es-UY", { hour: "2-digit", minute: "2-digit" });
  
  // Para mensajes de usuario (row-reverse), los adjuntos deben ir DESPUÉS del contenido
  // para aparecer a la derecha junto al avatar. Para assistant, van antes (izquierda).
  const adjuntosHTML = renderAdjuntosHTML(atts);
  if (role === "user") {
    div.innerHTML =
      `<div class="msg-avatar">${role === "user" ? "TÚ" : "AE"}</div>` +
      `<div class="msg-body">` +
        `<div class="msg-meta"><span class="who">${role === "user" ? "Vos" : "Aether"}</span>` +
        `<span>${escapeHtml(hora)}</span></div>` +
        `<div class="msg-content">${renderTexto(text)}</div>` +
        adjuntosHTML +
      `</div>`;
  } else {
    div.innerHTML =
      `<div class="msg-avatar">${role === "user" ? "TÚ" : "AE"}</div>` +
      `<div class="msg-body">` +
        `<div class="msg-meta"><span class="who">${role === "user" ? "Vos" : "Aether"}</span>` +
        `<span>${escapeHtml(hora)}</span></div>` +
        adjuntosHTML +
        `<div class="msg-content">${renderTexto(text)}</div>` +
      `</div>`;
  }
  box.appendChild(div);
  /* Thumbnail con fallback: si el backend ya no tiene el archivo (mensaje
     viejo, adjunto borrado), la <img> degrada a chip en vez de quedar el
     ícono de imagen rota del navegador. */
  div.querySelectorAll(".msg-attachments img").forEach((img) => {
    img.addEventListener("error", () => {
      const chip = document.createElement("span");
      chip.className = "msg-file";
      chip.textContent = img.getAttribute("alt") || "imagen";
      img.replaceWith(chip);
    });
  });
  /* Bloque unificado estado+razonamiento (mensajes persistidos con
     reasoning): "✓ Completado" expandible con un click. Sin reasoning no
     se crea bloque alguno (nada de toggles inútiles). */
  if (reasoning && window.ReasoningBlock) {
    const bloqueHist = window.ReasoningBlock.crearBloqueHistorial(reasoning);
    if (bloqueHist) {
      const cuerpo = div.querySelector(".msg-body");
      const contenido = div.querySelector(".msg-content");
      if (cuerpo && contenido) cuerpo.insertBefore(bloqueHist.root, contenido);
    }
  }
  if (scroll) box.scrollTop = box.scrollHeight;
  return div;
}

/* ═══════════ Adjuntos del composer ([+] imágenes y archivos) ════════════
   Se leen como base64, se muestran como chips/thumbnails y se mandan en el
   body del chat ({attachments: [{name, mime, data}]}). El backend los guarda
   en ~/Aether/adjuntos y compone la orden (texto embebido, imágenes descritas
   por el modelo de visión). */

const ADJ_MAX_BYTES = 10 * 1024 * 1024;   // espejo del tope del backend
const ADJ_EXT_TEXTO = new Set(["txt", "md", "py", "js", "ts", "json", "csv",
  "log", "sh", "yaml", "yml", "toml", "xml", "html", "css", "sql", "rs",
  "go", "lua", "ini", "cfg", "conf", "env", "diff", "jsx", "tsx"]);

function kindDeAdjunto(name, mime) {
  if ((mime || "").startsWith("image/")) return "image";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if ((mime || "").startsWith("text/")
      || ["application/json", "application/javascript", "application/xml"].includes(mime)
      || ADJ_EXT_TEXTO.has(ext)) return "text";
  return "other";
}

function agregarAdjuntos(files) {
  for (const f of files) {
    if (adjuntos.length >= 8) { toast("Máximo 8 adjuntos por mensaje", false); break; }
    if (f.size > ADJ_MAX_BYTES) { toast(`'${f.name}' supera 10 MB`, false); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      adjuntos.push({
        name: f.name,
        mime: f.type || "application/octet-stream",
        kind: kindDeAdjunto(f.name, f.type),
        data: url.includes(",") ? url.slice(url.indexOf(",") + 1) : "",
        url,  // dataURL viva en memoria (preview)
      });
      pintarAdjuntos();
    };
    reader.readAsDataURL(f);
  }
}

function pintarAdjuntos() {
  const tray = $("attach-tray");
  tray.innerHTML = "";
  tray.hidden = adjuntos.length === 0;
  adjuntos.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.title = `${a.mime} · ${Math.round(a.data.length * 3 / 4 / 1024)} KB`;
    if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = a.name;
      chip.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.innerHTML = a.kind === "text" ? ICO("file-text") : ICO("file");
      chip.appendChild(icon);
    }
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = a.name;
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.innerHTML = ICO("x");
    rm.title = "Quitar";
    rm.addEventListener("click", () => { adjuntos.splice(i, 1); pintarAdjuntos(); });
    chip.appendChild(nm);
    chip.appendChild(rm);
    tray.appendChild(chip);
  });
}

/* Meta de adjuntos para persistir en localStorage: las imágenes grandes se
   guardan solo como chip (sin dataURL) para no reventar la cuota (~5 MB). */
function metaAdjuntos(atts) {
  const MAX_URL_PERSISTIDA = 250 * 1024;
  return atts.map((a) => ({
    name: a.name,
    mime: a.mime,
    kind: a.kind,
    /* Path del adjunto guardado por el backend (viene en las metas del
       upload): permite volver a mostrar el thumbnail desde
       /api/attachments/file aunque el dataURL no se persista. */
    path: a.path || null,
    url: (a.kind === "image" && a.url && a.url.length < MAX_URL_PERSISTIDA)
      ? a.url : null,
  }));
}

// Upload adjuntos al backend (mult)
async function subirAdjuntos(atts) {
  const form = new FormData();
  for (const a of atts) {
    const bin = atob(a.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: a.mime });
    form.append("files", blob, a.name);
  }
  const resp = await fetch(`${API_BASE}/api/attachments/upload`, {
    method: "POST",
    body: form,
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || "Upload falló");
  return json;
}

/* ═══════════ Menú de attach ([+] popup) ═══════════
   Archivo/foto/cámara/dictado + vistas rápidas de MCPs (activar y editar),
   agentes (seleccionar/crear) y skills. Respeta el patrón del prototipo
   (aether-attach-menu.html) con el tema de esta UI. */

function cerrarAttachMenu() {
  $("attach-menu").hidden = true;
  $("btn-attach").classList.remove("open");
  $("btn-attach").setAttribute("aria-expanded", "false");
}

function mostrarVistaAttach(nombre) {
  document.querySelectorAll("#attach-menu .atview").forEach((v) => {
    v.hidden = v.dataset.atview !== nombre;
  });
  if (nombre === "mcp") cargarMenuMcps();
  if (nombre === "agents") cargarMenuAgentes();
  if (nombre === "skills") cargarMenuSkills();
}

function abrirAttachMenu() {
  cerrarAttachMenu();          // resetea clases/aria
  $("attach-menu").hidden = false;
  $("btn-attach").classList.add("open");
  $("btn-attach").setAttribute("aria-expanded", "true");
  mostrarVistaAttach("root");
  refrescarResumenesMenu();
}

async function refrescarResumenesMenu() {
  /* Subtítulos del root (best-effort: errores → "—"). */
  try {
    const r = await wsCall("/api/mcps");
    const n = (r.servers || []).filter((s) => s.enabled).length;
    $("am-mcp-sub").textContent = n ? `${n} activo${n > 1 ? "s" : ""}` : "ninguno activo";
  } catch { $("am-mcp-sub").textContent = "—"; }
  try {
    const r = await wsCall("/api/agents");
    $("am-agent-sub").textContent = r.actual ? `activo: ${r.actual}` : "—";
  } catch { $("am-agent-sub").textContent = "—"; }
  try {
    const r = await wsCall("/api/skills");
    const n = (r.skills || []).length;
    $("am-skill-sub").textContent = n ? `${n} instalada${n > 1 ? "s" : ""}` : "ninguna";
  } catch { $("am-skill-sub").textContent = "—"; }
  /* Disponibilidad del dictado (cacheada: no levanta el worker). */
  sttEstado().then((s) => {
    $("am-mic-sub").textContent = s.available
      ? "Transcribe con whisper"
      : "no disponible (requiere whisper)";
  });
}

/* ── Menú [+] ▸ MCPs: toggle rápido + ✎ editar (token revocado, etc.) ── */

async function cargarMenuMcps() {
  const box = $("am-mcp-list");
  box.innerHTML = `<div class="am-empty">cargando…</div>`;
  let servers = [];
  try { servers = (await wsCall("/api/mcps")).servers || []; }
  catch (e) { box.innerHTML = `<div class="am-empty">[!] ${escapeHtml(e.message)}</div>`; return; }
  box.innerHTML = servers.length ? "" : `<div class="am-empty">(sin MCPs configurados)</div>`;
  for (const s of servers) {
    const btn = document.createElement("button");
    btn.className = "am-item" + (s.enabled ? " on" : "");
    btn.title = "Click: activar/desactivar · editar";
    btn.innerHTML =
      `<span class="am-ico">${ICO("plug")}</span>` +
      `<span class="am-text">${escapeHtml(s.name)}<span class="am-sub">${s.enabled ? "activo" : "inactivo"}</span></span>` +
      `<span class="am-check">${ICO("check")}</span>`;
    btn.addEventListener("click", async () => {
      try {
        await wsCall(`/api/mcps/${encodeURIComponent(s.name)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: s.name, transport: s.transport, command: s.command,
            args: s.args,
            env: Object.fromEntries(Object.keys(s.env || {}).map((k) => [k, MCP_MASK])),
            enabled: !s.enabled,
          }),
        });
        s.enabled = !s.enabled;
        cargarMenuMcps();
        refrescarResumenesMenu();
      } catch (e) { toast(e.message, false); }
    });
    const editar = document.createElement("button");
    editar.className = "am-edit";
    editar.innerHTML = ICO("pencil");
    editar.title = "Editar (token revocado o vencido, command, args…)";
    editar.addEventListener("click", (e) => {
      e.stopPropagation();
      cerrarAttachMenu();
      abrirEdicionMcp(s);
    });
    btn.appendChild(editar);
    box.appendChild(btn);
  }
}

/* ── Menú [+] ▸ Agentes: seleccionar activo + crear custom ── */

async function cargarMenuAgentes() {
  const box = $("am-agents-list");
  box.innerHTML = `<div class="am-empty">cargando…</div>`;
  let r;
  try { r = await wsCall("/api/agents"); }
  catch (e) { box.innerHTML = `<div class="am-empty">[!] ${escapeHtml(e.message)}</div>`; return; }
  const agentes = r.agents || [];
  const actual = r.actual || "build";
  box.innerHTML = "";
  for (const a of agentes) {
    const btn = document.createElement("button");
    btn.className = "am-item" + (a.name === actual ? " on" : "");
    btn.title = "Usar este agente";
    btn.innerHTML =
      `<span class="am-ico">${a.kind === "custom" ? ICO("star") : ICO("bot")}</span>` +
      `<span class="am-text">${escapeHtml(a.name)}` +
      `<span class="am-sub">${escapeHtml(a.descripcion || a.kind || "")}</span></span>` +
      `<span class="am-check">${ICO("check")}</span>`;
    btn.addEventListener("click", async () => {
      try {
        await wsPost("/api/agent", { agent: a.name });
        toast(`Agente activo: ${a.name}`);
        cargarMenuAgentes();
        refrescarResumenesMenu();
        refrescarStatus();
      } catch (e) { toast(e.message, false); }
    });
    box.appendChild(btn);
  }
}

/* ── Menú [+] ▸ Skills (el agente las carga on-demand; acá se listan) ── */

async function cargarMenuSkills() {
  const box = $("am-skills-list");
  box.innerHTML = `<div class="am-empty">cargando…</div>`;
  let skills = [];
  try { skills = (await wsCall("/api/skills")).skills || []; }
  catch (e) { box.innerHTML = `<div class="am-empty">[!] ${escapeHtml(e.message)}</div>`; return; }
  box.innerHTML = skills.length ? "" : `<div class="am-empty">(sin skills instaladas)</div>`;
  for (const s of skills) {
    const btn = document.createElement("button");
    btn.className = "am-item";
    btn.title = "Ver en el workspace";
    btn.innerHTML =
      `<span class="am-ico">${ICO("sparkles")}</span>` +
      `<span class="am-text">${escapeHtml(s.name)}` +
      `<span class="am-sub">${escapeHtml(s.description || "")}</span></span>`;
    btn.addEventListener("click", () => {
      cerrarAttachMenu();
      abrirWorkspace("wtab-skills");
    });
    box.appendChild(btn);
  }
}

/* ── Cámara (getUserMedia → foto jpeg al tray de adjuntos) ── */

let camStream = null;
let camShotDataUrl = null;

function reiniciarVistaCamara() {
  $("cam-shot").hidden = true;
  $("cam-video").style.display = "block";
  $("cam-actions-live").hidden = false;
  $("cam-actions-shot").hidden = true;
}

async function abrirCamara() {
  $("cam-overlay").hidden = false;
  reiniciarVistaCamara();
  const st = $("cam-status");
  st.style.display = "flex";
  st.textContent = "Pidiendo acceso a la cámara…";
  $("cam-video").style.display = "none";
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, audio: false,
    });
    $("cam-video").srcObject = camStream;
    $("cam-video").style.display = "block";
    st.style.display = "none";
  } catch {
    st.textContent = "No se pudo acceder a la cámara. Revisá los permisos del navegador.";
  }
}

function cerrarCamara() {
  $("cam-overlay").hidden = true;
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
}

$("cam-close").addEventListener("click", cerrarCamara);
$("cam-overlay").addEventListener("click", (e) => {
  if (e.target === $("cam-overlay")) cerrarCamara();
});
$("cam-shutter").addEventListener("click", () => {
  const video = $("cam-video");
  const canvas = $("cam-canvas");
  if (!video.videoWidth || !video.videoHeight) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  camShotDataUrl = canvas.toDataURL("image/jpeg", 0.9);
  $("cam-shot").src = camShotDataUrl;
  $("cam-shot").hidden = false;
  $("cam-video").style.display = "none";
  $("cam-actions-live").hidden = true;
  $("cam-actions-shot").hidden = false;
});
$("cam-retake").addEventListener("click", reiniciarVistaCamara);
$("cam-use").addEventListener("click", () => {
  if (camShotDataUrl) {
    const hhmm = new Date().toTimeString().slice(0, 5).replace(":", "");
    adjuntos.push({
      name: `camara-${hhmm}.jpg`,
      mime: "image/jpeg",
      kind: "image",
      data: camShotDataUrl.slice(camShotDataUrl.indexOf(",") + 1),
      url: camShotDataUrl,
    });
    pintarAdjuntos();
  }
  cerrarCamara();
});

/* ── Dictado por voz (🎙 → POST /api/stt/transcribe, whisper/faster-whisper) ──
   Graba con MediaRecorder, manda el blob al backend y pega la transcripción
   en el input. Esc cancela sin transcribir. */

let micRecorder = null;
let micStreamAudio = null;
let micChunks = [];
let micCancelar = false;
let sttInfo = null;   // cache de /api/stt/status (no levanta el worker)

async function sttEstado() {
  if (sttInfo) return sttInfo;
  try { sttInfo = await wsCall("/api/stt/status"); }
  catch { sttInfo = { available: false, detail: "el backend no tiene /api/stt" }; }
  return sttInfo;
}

async function toggleMic() {
  if (micRecorder) {
    micRecorder.stop();   // dispara onstop → finalizarDictado()
    return;
  }
  const est = await sttEstado();
  if (!est.available) {
    toast(`Dictado no disponible: ${est.detail || "requiere whisper"}`, false);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Sin permiso de micrófono (revisá el candado del navegador)", false);
    return;
  }
  micStreamAudio = stream;
  micCancelar = false;
  micChunks = [];
  try {
    micRecorder = new MediaRecorder(stream);
  } catch (e) {
    toast(`MediaRecorder no disponible: ${e.message}`, false);
    stream.getTracks().forEach((t) => t.stop());
    micStreamAudio = null;
    return;
  }
  micRecorder.ondataavailable = (e) => { if (e.data && e.data.size) micChunks.push(e.data); };
  micRecorder.onstop = () => { void finalizarDictado(); };
  micRecorder.start();
  const input = $("input");
  input.placeholder = "Grabando… hablá y tocá ■ (Esc cancela)";
  autoResize();
  $("btn-mic").classList.add("recording");
  $("btn-mic").innerHTML = ICO("square");
  toast("Grabando — tocá ■ para transcribir");
}

function cancelarMic() {
  if (!micRecorder) return;
  micCancelar = true;
  micRecorder.stop();
}

async function finalizarDictado() {
  const mime = (micRecorder && micRecorder.mimeType) || "audio/webm";
  micRecorder = null;
  if (micStreamAudio) {
    micStreamAudio.getTracks().forEach((t) => t.stop());
    micStreamAudio = null;
  }
  const btn = $("btn-mic");
  btn.classList.remove("recording");
  btn.innerHTML = ICO("mic");
  const input = $("input");
  input.placeholder = "Preguntale lo que quieras a Aether…";
  if (micCancelar) { micCancelar = false; return; }
  const blob = new Blob(micChunks, { type: mime });
  micChunks = [];
  if (blob.size < 1000) { toast("Grabación muy corta, no se transcribió", false); return; }
  btn.disabled = true;
  btn.classList.add("transcribiendo");
  btn.innerHTML = '<span class="activity-spinner"></span>';
  toast("Transcribiendo (whisper)…");

  /* Mientras whisper transcribe: el input queda bloqueado (no se puede
     escribir ni enviar) y el placeholder muestra "transcribiendo" con la
     animación de puntos, hasta que llega la respuesta del backend. */
  input.disabled = true;
  input.classList.add("transcribiendo");
  $("btn-send").disabled = true;
  input.placeholder = "transcribiendo…";
  let puntos = 1;
  const animPuntos = setInterval(() => {
    input.placeholder = "transcribiendo" + ".".repeat(puntos);
    puntos = (puntos % 3) + 1;   // 1 → 2 → 3 → 1
  }, 400);
  try {
    const form = new FormData();
    form.append("file", blob, mime.includes("ogg") ? "voz.ogg" : "voz.webm");
    const r = await wsCall("/api/stt/transcribe", { method: "POST", body: form });
    if (r.ok === false) throw new Error(r.error || "error de transcripción");
    const texto = (r.text || "").trim();
    if (!texto) { toast("No se detectó voz clara", false); return; }
    input.value = (input.value ? input.value.trimEnd() + " " : "") + texto;
    autoResize();
    toast(`Dictado listo${r.language ? ` (${r.language})` : ""}`);
  } catch (e) {
    toast(`Transcripción falló: ${e.message}`, false);
  } finally {
    clearInterval(animPuntos);
    btn.disabled = false;
    btn.classList.remove("transcribiendo");
    btn.innerHTML = ICO("mic");
    input.classList.remove("transcribiendo");
    input.disabled = streamingActivo;         // si hay streaming, sigue bloqueado
    $("btn-send").disabled = streamingActivo;
    input.placeholder = "Preguntale lo que quieras a Aether…";
    if (!streamingActivo) input.focus();   // habilitado recién: ahora sí puede recibir foco
  }
}

function tituloDe(texto) {
  const t = texto.trim().replace(/\s+/g, " ");
  return t.length > 40 ? `${t.slice(0, 40)}…` : (t || "Nueva conversación");
}

/* ════════════ Panel ACTIVIDAD (port de tui/widgets/plan_panel.py) ════
   Consume el delta de los eventos "node" del SSE (/api/chat/stream). */

/* Ícono lucide por tool (el nombre se resuelve con ICO() al pintar). */
const ICONOS_TOOL = {
  text: "message-square", web: "search", shell: "terminal", launch: "rocket",
  vision: "eye", codigo: "code", memory: "brain",
  file_write: "save", extract: "scan-search", mcp: "plug",
  computer_use: "mouse", subagent: "bot",
  fs_write: "file-pen", fs_read: "book-open", fs_mkdir: "folder-plus", fs_list: "folder-open",
};

const ETIQUETAS_TOOL = {
  fs_write: "Escribiendo archivo", fs_read: "Leyendo archivo",
  fs_mkdir: "Creando carpeta", fs_list: "Listando carpeta",
  file_write: "Guardando archivo", shell: "Ejecutando comando",
  codigo: "Generando código", web: "Buscando en la web",
  vision: "Analizando pantalla", mcp: "Llamando MCP",
  computer_use: "Controlando interfaz", launch: "Abriendo app",
  memory: "Gestionando memoria", text: "Respondiendo",
  subagent: "Sub-agentes paralelos",
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
  const icono = ICONOS_TOOL[tool] || "circle";
  const etiqueta = ETIQUETAS_TOOL[tool] || tool;
  const detalle = resumirArgs(args);
  let linea = etiqueta;
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
  return { icon: icono, text: linea };
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

function agregarActividad(paso) {
  const linea = stripAnsi(paso.text || "").trim();
  if (!linea) return;
  const previa = planState.actividad[planState.actividad.length - 1];
  if (previa && previa.text === linea) return;
  planState.actividad.push({ icon: paso.icon || "circle", text: linea });
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
    const icono = ICONOS_TOOL[tool] || "circle";
    const completado = (i + 1) <= planState.index;
    const li = document.createElement("li");
    li.className = completado ? "completado"
      : ((i + 1) === planState.index + 1 && planState.activo ? "en-curso" : "pendiente");
    li.innerHTML = `<span class="paso-check">${completado ? ICO("check") : ICO("circle")}</span>${ICO(icono)} <span>${escapeHtml(tool)}</span>`;
    ulPasos.appendChild(li);
  });
  if (planificando) {
    const li = document.createElement("li");
    li.className = "pendiente";
    li.textContent = "planificando…";
    ulPasos.appendChild(li);
  }

  ulAct.innerHTML = "";
  for (const paso of planState.actividad) {
    const li = document.createElement("li");
    li.innerHTML = `${ICO(paso.icon)}<span>${escapeHtml(paso.text)}</span>`;
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

function fechaSesionLegible(iso) {
  /* "2026-09-15T02:53:00" → "hoy 02:53" / "ayer 02:53" / "15 sep 02:53" */
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "").slice(5, 16);
  const hhmm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const ese = new Date(d); ese.setHours(0, 0, 0, 0);
  const dias = Math.round((hoy - ese) / 86400000);
  if (dias === 0) return `hoy ${hhmm}`;
  if (dias === 1) return `ayer ${hhmm}`;
  return `${d.getDate()} ${d.toLocaleDateString("es-AR", { month: "short" })} ${hhmm}`;
}

function pintarSessionList() {
  const ul = $("session-list");
  ul.innerHTML = "";
  // Filtrar sesiones sin mensajes del usuario: se acumulan vacías por restarts
  // del runtime y solo ensucian el sidebar.
  const visibles = sesiones.filter((s) => s.preview && s.preview.trim());
  $("sesiones-count").textContent = visibles.length ? `${visibles.length}` : "";
  for (const s of visibles) {
    const li = document.createElement("li");
    li.title = `${s.inicio}\n${s.turnos} turnos`;
    if (sesionVista && sesionVista.id === s.sesion_id) li.classList.add("active");
    const fecha = fechaSesionLegible(s.inicio);
    const preview = s.preview;
    li.innerHTML =
      `<span class="ses-meta">${escapeHtml(fecha)}</span> ${escapeHtml(preview)}`;
    li.addEventListener("click", () => abrirSesion(s.sesion_id));
    ul.appendChild(li);
  }
  if (!visibles.length) {
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
  if (streamingActivo) return;
  if (!texto && !adjuntos.length) return;

  /* Subir adjuntos al backend ANTES de enviar el mensaje */
  let metasSubidas = [];
  if (adjuntos.length > 0) {
    try {
      const json = await subirAdjuntos(adjuntos);
      metasSubidas = json.metas || [];
      toast(`${metasSubidas.length} adjunto(s) subido(s)`);
    } catch (err) {
      toast(`Upload falló: ${err.message}`, false);
      return;
    }
  }

  /* Consumir los adjuntos pendientes (fallback si backend 4xx y querés
     reintentar: quedaron en la burbuja del usuario igual). */
  const atts = adjuntos.splice(0);
  pintarAdjuntos();

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
    convActual.title = tituloDe(texto || atts.map((a) => a.name).join(", "));
  }

  convActual.messages.push({ role: "user", text: texto, attachments: metaAdjuntos(metasSubidas.length ? metasSubidas : atts) });
  // Usar atts originales (tienen url/dataURL) para que renderAdjuntosHTML muestre thumbnails
  agregarBurbuja("user", texto, true, "", atts);
  persistirConvs();
  pintarConvList();
  pintarMensajes();  // refresca el título del chat

  resetPlanTurno();
  setBusy(true);

  const burbuja = agregarBurbuja("assistant", "…");
  const msgBody = burbuja.querySelector(".msg-body");
  const contentEl = burbuja.querySelector(".msg-content");
  let acumulado = "";

  /* ── Bloque unificado de ESTADO + RAZONAMIENTO (reasoning_block.js) ──
     Spec Open WebUI: el bloque existe si el modelo soporta reasoning.
     Ahora lo creamos EAGER al recibir 'start' si ev.reasoning===true.
     Un modelo sin reasoning streamea su respuesta directo y jamás
     ve "Pensando..." ni un panel vacío. El razonamiento llega por su
     PROPIO canal (el backend lo separa del content): acá NO se parsea el
     stream de tokens. */
  let rblock = null;
  let modelHasReasoning = false;
  const ensureRblock = () => {
    if (rblock || !window.ReasoningBlock) return rblock;
    rblock = window.ReasoningBlock.crearBloque();
    msgBody.insertBefore(rblock.root, contentEl);
    return rblock;
  };

  const setActividad = (t) => {
    $("activity-chip").hidden = false;
    $("activity-text").textContent = t;
  };

  try {
    abortStream = new AbortController();
    const resp = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: texto,
        attachments: (metasSubidas.length
          // Upload OK: referenciar por path (las metas del backend NO traen
          // data; mandarlas con data era el bug del "adjunto vacío").
          ? metasSubidas.map((m) => ({ name: m.name, mime: m.mime, path: m.path }))
          // Fallback (upload falló): base64 crudo, el backend lo guarda.
          : atts.map((a) => ({ name: a.name, mime: a.mime, data: a.data }))),
      }),
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

          if (ev.type === "start") {
            /* El backend ahora incluye 'reasoning' boolean indicando si el
               modelo soporta razonamiento nativo. Si true, creamos el bloque
               EAGER (antes del primer fragmento) para que el usuario vea
               "✦ Pensando..." desde el inicio. */
            if (ev.reasoning === true) {
              modelHasReasoning = true;
              ensureRblock();
            }
          } else if (ev.type === "token") {
            /* Tokens = SOLO la respuesta final: el backend ya separó el
               razonamiento en su propio canal; nada que parsear acá. */
            acumulado += ev.data;
            contentEl.innerHTML = renderTexto(acumulado);
            $("messages").scrollTop = $("messages").scrollHeight;
          } else if (ev.type === "reasoning") {
            /* Fragmento de razonamiento → streamea debajo del bloque.
               El bloque ya existe si modelHasReasoning=true, si no, lo creamos
               lazy (compatibilidad con modelos antiguos). */
            const rb = ensureRblock();
            if (rb) rb.pushReasoning(ev.data);
          } else if (ev.type === "node") {
            /* Estado humano (mismo mapa que la TUI, lo arma el backend):
               alimenta el chip global de actividad y la cabecera del bloque
               (que rota verbos genéricos: Husmeando, Cocinando, ...). */
            setActividad(ev.estado || `nodo: ${ev.node}`);
            actualizarPlanDelta(ev.node, ev.delta);
            if (rblock) rblock.setStatus(ev.estado || "");
          } else if (ev.type === "log") {
            agregarLogLinea(ev.data);
            const log = $("activity-log");
            log.hidden = false;
            log.textContent = ev.data.slice(0, 160);
          } else if (ev.type === "done") {
            /* done.reasoning = razonamiento completo del turno (fuente
               autoritativa del backend, por si se perdió algún fragmento). */
            /* Ya viene limpia del backend (limpiar_respuesta_chat, la misma
               función que usa la TUI para su respuesta final). */
            acumulado = ev.response || acumulado || "Operación completada.";
            contentEl.innerHTML = renderTexto(acumulado);
            if (rblock) rblock.finalizar(ev.reasoning || "");
          } else if (ev.type === "error") {
            acumulado = `[!] ${ev.message}`;
            burbuja.classList.add("error");  // FIX: clase .error (existe en CSS)
            contentEl.innerHTML = renderTexto(acumulado);
            if (rblock) rblock.error();
            agregarLogLinea(ev.message, true);
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      acumulado += "\n\n[X] *cancelado*";
    } else {
      acumulado = `[!] Sin conexión con el backend: ${err.message}`;
      burbuja.classList.add("error");
      agregarLogLinea(`Error de conexión: ${err.message}`, true);
    }
    contentEl.innerHTML = renderTexto(acumulado);
    /* El bloque no queda "vivo" para siempre al cortarse el stream:
       cancelación → conserva el razonamiento recibido (queda expandible);
       error de conexión → estado de error (y se descarta si no hay
       razonamiento, en el finally). */
    if (rblock) {
      if (err.name === "AbortError") rblock.finalizar(rblock.reasoning());
      else rblock.error();
    }
  } finally {
    /* El razonamiento queda persistido con el mensaje: al reabrir la
       conversación el chip "Pensado — ver razonamiento" sigue disponible. */
    convActual.messages.push({
      role: "assistant",
      text: acumulado,
      reasoning: (rblock ? rblock.reasoning() : "") || undefined,
    });
    /* Sin razonamiento: el bloque de estado ya cumplió su función y se
       retira (nada de toggles inútiles). Con razonamiento queda como
       "✓ Completado", expandible para siempre. */
    if (rblock && window.ReasoningBlock.debeDescartarBloque(rblock.estado)) {
      rblock.root.remove();
    }
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
    /* status="error" crudo quedaba como badge rojo permanente sin contexto;
       dar el porqué y dónde mirar. */
    const statusTxt = st.busy ? "ocupado" : (online ? "online"
      : (st.status === "error" ? "error interno (ver logs del backend)"
         : (st.status || "offline")));
    $("status-text").textContent = statusTxt;
    $("status-text").title = (st.status === "error")
      ? "El backend devolvió status=error al consultar /api/status. Revisá los logs del proceso del backend."
      : "";
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
    $("rt-effort").textContent = st.effort || "—";
    $("rt-agent").textContent = st.agent || "—";
    if (!sesionVista) $("chat-sub").textContent = `Local · ${st.model || "—"}`;
  } catch {
    $("status-dot").className = "status-dot offline";
    $("status-text").textContent = "backend offline";
    $("status-model").textContent = "—";
    $("status-host").textContent = "—";
    $("rt-dot").className = "rt-dot offline";
    /* Sin esto, el runtime panel quedaba con "…" y la tarjeta con
       "cargando…" para siempre cuando el backend no responde. */
    $("rt-sub").textContent = "Sin conexión con el backend";
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
      return true;
    }
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name + (m.active ? "  •" : "");
      if (m.active) opt.selected = true;
      sel.appendChild(opt);
    }
    return true;
  } catch {
    sel.innerHTML = '<option value="">(backend offline)</option>';
    return false;
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
    cargarConfigExtra();   // sección "Todos los parámetros (libre)"
  } catch { toast("No se pudo cargar la configuración", false); }
}

async function guardarConfigTUI() {
  const values = {};
  for (const k of CFG_FIELDS) {
    const raw = $(`cfg-${k}`).value;
    if (raw === "" || isNaN(parseFloat(raw))) continue;
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
      st.textContent = "[OK] guardado";
      toast("Configuración aplicada (config.json) — vale desde el próximo turno");
    } else {
      st.textContent = `[!] falló: ${fallidas.join(", ")}`;
      toast(`Validación rechazó: ${fallidas.join(", ")}`, false);
    }
    refrescarStatus();
  } catch (err) {
    st.textContent = `[X] ${err.message}`;
    toast(`Error: ${err.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 4000);
  }
}

/* ════════════ Settings: TODOS los parámetros (config libre) ═══════════
   /api/config lee y escribe config.json via ConfigManager; las claves sin
   validador pasan directo (el backend ya lo permite). Acá se renderiza TODO
   menos las claves con UI dedicada arriba (y las de cuenta/agente, que se
   editan en su propia pestaña). Números → input numérico, bool → checkbox,
   dict/list → textarea JSON. Se guarda solo lo que cambió (diff). */

const CFG_EXTRA_EXCLUIDAS = new Set([
  ...CFG_FIELDS, ...CFG_CHECKS,
  "ACCOUNT_PROFILE", "ACCOUNT_PREFERENCES", "CUSTOM_AGENTS",
]);
let cfgExtraSnapshot = {};   // para guardar solo los cambios

function _filaConfigExtra(clave, valor) {
  const wrap = document.createElement("div");
  wrap.className = "cfg-extra-row";
  const lab = document.createElement("span");
  lab.className = "cfg-extra-key";
  lab.textContent = clave;
  lab.title = clave;
  wrap.appendChild(lab);

  let input;
  if (typeof valor === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = valor;
  } else if (typeof valor === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = valor;
  } else if (valor !== null && typeof valor === "object") {
    input = document.createElement("textarea");
    input.rows = 2;
    input.value = JSON.stringify(valor, null, 2);
    input.title = "Editar como JSON";
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = (valor ?? "");
  }
  input.dataset.cfgExtra = clave;
  wrap.appendChild(input);
  return wrap;
}

async function cargarConfigExtra() {
  const box = $("cfg-extra-list");
  box.innerHTML = `<p class="muted small">cargando parámetros…</p>`;
  try {
    const r = await (await api("/api/config")).json();
    const cfg = r.config || {};
    cfgExtraSnapshot = {};
    box.innerHTML = "";
    for (const clave of Object.keys(cfg).sort()) {
      if (CFG_EXTRA_EXCLUIDAS.has(clave)) continue;
      cfgExtraSnapshot[clave] = cfg[clave];
      box.appendChild(_filaConfigExtra(clave, cfg[clave]));
    }
    if (!box.childElementCount) {
      box.innerHTML = '<p class="muted small">(sin parámetros adicionales)</p>';
    }
  } catch (e) {
    box.innerHTML = `<p class="muted small">[!] ${escapeHtml(e.message)}</p>`;
  }
}

async function guardarConfigExtra() {
  const st = $("cfg-extra-status");
  const values = {};
  const errores = [];
  for (const input of document.querySelectorAll("[data-cfg-extra]")) {
    const clave = input.dataset.cfgExtra;
    const original = cfgExtraSnapshot[clave];
    let val;
    try {
      if (input.type === "checkbox") {
        val = input.checked;
      } else if (input.type === "number") {
        /* int si era int, float si era float */
        val = Number.isInteger(original) ? parseInt(input.value, 10)
                                         : parseFloat(input.value);
        if (Number.isNaN(val)) throw new Error("no es número");
      } else if (input.tagName === "TEXTAREA") {
        val = JSON.parse(input.value);
      } else {
        val = input.value;
      }
    } catch {
      errores.push(clave);
      continue;
    }
    if (JSON.stringify(val) !== JSON.stringify(original)) values[clave] = val;
  }
  if (!Object.keys(values).length) {
    st.textContent = errores.length
      ? `[!] JSON inválido en: ${errores.join(", ")}`
      : "(sin cambios)";
    setTimeout(() => { st.textContent = ""; }, 4000);
    return;
  }
  try {
    const r = await (await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    })).json();
    const fallidas = Object.entries(r.results || {})
      .filter(([, v]) => !v).map(([k]) => k);
    Object.assign(cfgExtraSnapshot, values);
    st.textContent = fallidas.length
      ? `[!] validación rechazó: ${fallidas.join(", ")}`
      : `[OK] ${Object.keys(values).length} parámetro(s) guardados`;
    toast(fallidas.length
      ? `Rechazadas: ${fallidas.join(", ")}`
      : "Parámetros aplicados (config.local.json, efecto inmediato)", !fallidas.length);
    refrescarStatus();
  } catch (e) {
    st.textContent = `[X] ${e.message}`;
    toast(`Error: ${e.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 6000);
  }
}

/* ══════════════════════════ Settings: system prompt ══════════════════ */

async function cargarSystemPrompt() {
  try {
    const sp = await (await api("/api/system-prompt")).json();
    $("sp-behavior").value = sp.behavior ?? "";
    $("sp-override").value = sp.override ?? "";
    $("sp-extra").value = sp.extra ?? "";
    $("sp-sintesis").value = sp.sintesis_extra ?? "";
  } catch { toast("No se pudo cargar el system prompt", false); }
  /* Mostrar el prompt REAL (el genérico, efectivo ahora) sin tener que
     tocar "Preview": es lo que el usuario espera ver al abrir la pestaña. */
  try {
    const r = await (await api("/api/system-prompt/preview")).json();
    const box = $("prompt-preview");
    box.hidden = false;
    box.innerHTML =
      `<b>── SYSTEM PROMPT (ejecución — shell/files) ──</b>\n${escapeHtml(r.backstory || "")}\n\n` +
      `<b>── AGENT LOOP (tool calling nativo) ──</b>\n${escapeHtml(r.agent_loop || "")}\n\n` +
      `<b>── PERSONA SÍNTESIS ──</b>\n${escapeHtml(r.persona_sintesis || "")}`;
  } catch { /* sin preview: no es bloqueante */ }
}

async function guardarSystemPrompt() {
  const body = {
    behavior: $("sp-behavior").value,
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
    st.textContent = r.ok ? "[OK] guardado" : "[!] error al validar";
    toast(r.ok ? "System prompt aplicado — vale desde el próximo turno"
              : "No se pudo guardar el system prompt", r.ok);
    refrescarStatus();
  } catch (err) {
    st.textContent = `[X] ${err.message}`;
    toast(`Error: ${err.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 4000);
  }
}

async function previewSystemPrompt() {
  const box = $("prompt-preview");
  box.hidden = false;
  box.innerHTML = "generando preview…";
  try {
    const r = await (await api("/api/system-prompt/preview")).json();
    box.innerHTML =
      `<b>── SYSTEM PROMPT (ejecución — shell/files) ──</b>\n${escapeHtml(r.backstory || "")}\n\n` +
      `<b>── AGENT LOOP (tool calling nativo) ──</b>\n${escapeHtml(r.agent_loop || "")}\n\n` +
      `<b>── PERSONA SÍNTESIS ──</b>\n${escapeHtml(r.persona_sintesis || "")}`;
  } catch (err) {
    box.textContent = `Error: ${err.message}`;
  }
}

/* ── 👤 Account: guardar perfil ── */

async function guardarCuenta() {
  const st = $("acc-status");
  const body = {
    nombre: $("acc-nombre").value.trim(),
    bio: $("acc-bio").value.trim(),
    timezone: $("acc-timezone").value.trim(),
    idioma: $("acc-idioma").value.trim(),
    /* género → el agente te habla con esos pronombres (context_builder);
       'otro' exige pronombre_custom (lo valida el backend). */
    genero: $("acc-genero").value,
    pronombre_custom: $("acc-pronombre").value.trim(),
    /* fecha de nacimiento: visible para el modelo, solo relevante el día
       del cumpleaños (ver core/memory/context_builder.py). */
    fecha_nacimiento: $("acc-nacimiento").value,
  };
  try {
    const r = await wsPost("/api/account/profile", body);
    if (!r.ok) throw new Error(r.error || "No se pudo guardar");
    st.textContent = "[OK] guardado";
    toast("Perfil guardado");
  } catch (e) {
    st.textContent = `[X] ${e.message}`;
    toast(`Error: ${e.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 4000);
  }
}

/* ── 👤 Account: guardar preferencias ── */

async function guardarPreferencias() {
  const st = $("pref-status");
  const body = {
    tema: $("pref-tema").value,
    idioma_ui: $("pref-idioma").value,
    modo_compacto: $("pref-compacto").checked,
    notificaciones_push: $("pref-notif").checked,
  };
  try {
    const r = await wsPost("/api/account/preferences", body);
    if (!r.ok) throw new Error(r.error || "No se pudo guardar");
    st.textContent = "[OK] guardado";
    toast("Preferencias guardadas");
  } catch (e) {
    st.textContent = `[X] ${e.message}`;
    toast(`Error: ${e.message}`, false);
  } finally {
    setTimeout(() => { st.textContent = ""; }, 4000);
  }
}

/* ── 👤 Account: upload avatar (llama a /api/account/avatar) ── */

async function subirAvatar(file) {
  const form = new FormData();
  form.append("file", file);
  try {
    const r = await fetch(`${API_BASE}/api/account/avatar`, {
      method: "POST",
      body: form,
    });
    const json = await r.json();
    if (!json.ok) throw new Error(json.error || "Upload falló");
    toast("Avatar actualizado");
    $("avatar-preview").src = json.avatar_url;
    $("avatar-preview").hidden = false;
  } catch (e) {
    toast(`Error subiendo avatar: ${e.message}`, false);
  }
}

/* ══════════════════════════ Modal settings ══════════════════════════ */

function abrirSettings() {
  $("settings-modal").hidden = false;
  cargarConfigUI();
  cargarSystemPrompt();
}
function cerrarSettings() { $("settings-modal").hidden = true; }

/* Tabs de modales: scoped por modal (el settings usa data-tab y el workspace
   usa data-wtab; antes el handler era global y rompía al agregar el modal de
   workspace). Devuelve el id activado para que el caller haga fetch si quiere. */
function wireTabs(modalId, attr) {
  const modal = $(modalId);
  if (!modal) return;
  modal.querySelectorAll(".modal-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset[attr];
      modal.querySelectorAll(".modal-tabs .tab")
        .forEach((t) => t.classList.toggle("active", t === tab));
      modal.querySelectorAll(".tab-body").forEach((b) => { b.hidden = b.id !== id; });
      if (attr === "wtab" && WS_LOADERS[id]) WS_LOADERS[id]();
    });
  });
}
wireTabs("settings-modal", "tab");
wireTabs("workspace-modal", "wtab");

/* ═════════════════ Workspace modal ══════════════════════════════════════
   Proyectos · Memoria · Skills · Tareas · MCPs · Roblox · Effort & Agente.
   Cada tab consume los endpoints del backend con la MISMA fuente de datos
   que la TUI (config.json, mcp_servers.json, skills/, memoria.db…). */

/* fetch que devuelve el JSON y tira Error con el mensaje del backend en 4xx
   (los endpoints workspace devuelven {ok:false, error:"..."} o FastAPI 4xx). */
async function wsCall(path, opts) {
  const resp = await fetch(`${API_BASE}${path}`, opts);
  let data = null;
  try { data = await resp.json(); } catch { /* sin cuerpo */ }
  if (!resp.ok) {
    /* Errores HTTP sin cuerpo útil → mensaje humano, nunca "Not Found" crudo. */
    const pistas = {
      404: "el backend no tiene ese endpoint (¿versión vieja del backend?)",
      405: "método no permitido por el backend",
      500: "error interno del backend (ver logs)",
      502: "el backend no respondió bien",
      503: "backend ocupado o reiniciándose",
    };
    const base = (data && (data.error || data.detail))
      || `${resp.status} — ${pistas[resp.status] || "error del backend"}`;
    throw new Error(base);
  }
  return data || {};
}

const wsPost = (path, body) => wsCall(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

const wsDelete = (path) => wsCall(path, { method: "DELETE" });

function setStatusLine(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg || "";
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4500);
}

function liVacio(texto) {
  return `<li class="muted small">${escapeHtml(texto)}</li>`;
}

function botonBorrar(onClick) {
  const b = document.createElement("button");
  b.className = "btn-mini danger";
  b.textContent = "borrar";
  b.addEventListener("click", onClick);
  return b;
}

/* ── [P] Proyectos ── */

async function cargarProyectos() {
  const ul = $("proyectos-list");
  ul.innerHTML = liVacio("cargando…");
  try {
    const r = await wsCall("/api/proyectos");
    const ps = r.proyectos || [];
    ul.innerHTML = ps.length ? "" : liVacio("(sin proyectos registrados)");
    for (const p of ps) {
      const li = document.createElement("li");
      li.className = "item" + (p.existe ? "" : " off");
      li.innerHTML =
        `<div class="item-main">` +
          `<div class="item-title">${escapeHtml(p.name)} ` +
            (p.existe ? "" : '<span class="tag warn">ruta no existe</span>') +
          `</div>` +
          `<div class="item-sub">${escapeHtml(p.path || "")}</div>` +
          (p.descripcion ? `<div class="item-sub">${escapeHtml(p.descripcion)}</div>` : "") +
        `</div>` +
        `<div class="item-actions"></div>`;
      li.querySelector(".item-actions").appendChild(botonBorrar(async () => {
        try {
          await wsDelete(`/api/proyectos/${encodeURIComponent(p.name)}`);
          cargarProyectos();
        } catch (e) { toast(e.message, false); }
      }));
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = liVacio(`[!] ${e.message}`);
  }
}

async function agregarProyecto() {
  try {
    await wsPost("/api/proyectos", {
      name: $("proy-nombre").value,
      path: $("proy-ruta").value,
      descripcion: $("proy-desc").value,
    });
    $("proy-nombre").value = $("proy-ruta").value = $("proy-desc").value = "";
    setStatusLine("proy-status", "[OK] agregado");
    cargarProyectos();
  } catch (e) {
    setStatusLine("proy-status", `[X] ${e.message}`);
  }
}

/* ── [M] Memoria (resumen acumulativo + recuerdos) ── */

async function cargarMemoria() {
  try {
    const r = await wsCall("/api/memory/summary");
    const s = r.summary || {};
    $("mem-texto").value = s.texto || "";
    $("mem-turno").textContent = s.ultimo_turno_id ?? "—";
    $("mem-fecha").textContent = s.actualizado || "—";
  } catch (e) {
    setStatusLine("mem-status", `[!] ${e.message}`);
  }
  cargarRecuerdos();
}

async function cargarRecuerdos() {
  const ul = $("recuerdos-list");
  ul.innerHTML = liVacio("cargando…");
  try {
    const r = await wsCall("/api/memory/recuerdos");
    const recs = r.recuerdos || [];
    $("rec-count").textContent = recs.length ? `(${recs.length})` : "";
    ul.innerHTML = recs.length ? "" : liVacio("(sin recuerdos todavía)");
    for (const rec of recs) {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML =
        `<div class="item-main">` +
          `<div>${escapeHtml(rec.contenido || "")}</div>` +
          `<div class="item-sub">${escapeHtml(rec.categoria || "general")} · ` +
            `importancia ${rec.importancia ?? "?"} · ` +
            `${escapeHtml(String(rec.fecha || "").slice(0, 16))}</div>` +
        `</div>` +
        `<div class="item-actions"></div>`;
      li.querySelector(".item-actions").appendChild(botonBorrar(async () => {
        try {
          await wsDelete(`/api/memory/recuerdos/${rec.id}`);
          cargarRecuerdos();
        } catch (e) { toast(e.message, false); }
      }));
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = liVacio(`[!] ${e.message}`);
  }
}

async function guardarMemoria() {
  try {
    await wsPost("/api/memory/summary", { texto: $("mem-texto").value });
    setStatusLine("mem-status", "[OK] guardado (vale desde el próximo turno)");
  } catch (e) {
    setStatusLine("mem-status", `[X] ${e.message}`);
  }
}

async function consolidarMemoria() {
  setStatusLine("mem-status", "consolidando…");
  try {
    const r = await wsPost("/api/memory/consolidate", {});
    if (r.ok === false) { setStatusLine("mem-status", `[!] ${r.error}`); return; }
    $("mem-texto").value = r.texto || $("mem-texto").value;
    setStatusLine("mem-status", "[OK] resumen consolidado");
  } catch (e) {
    setStatusLine("mem-status", `[X] ${e.message}`);
  }
}

async function agregarRecuerdo() {
  try {
    await wsPost("/api/memory/recuerdos", {
      contenido: $("rec-contenido").value,
      categoria: $("rec-categoria").value,
      importancia: parseInt($("rec-importancia").value, 10) || 1,
    });
    $("rec-contenido").value = "";
    setStatusLine("rec-status", "[OK] guardado");
    cargarRecuerdos();
  } catch (e) {
    setStatusLine("rec-status", `[X] ${e.message}`);
  }
}

/* ── [*] Skills ── */

async function cargarSkills() {
  const ul = $("skills-list");
  ul.innerHTML = liVacio("cargando…");
  try {
    const r = await wsCall("/api/skills");
    const skills = r.skills || [];
    ul.innerHTML = skills.length ? "" : liVacio("(sin skills — creá una abajo)");
    for (const s of skills) {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML =
        `<div class="item-main">` +
          `<div class="item-title">${ICO("sparkles")} ${escapeHtml(s.name)}</div>` +
          `<div class="item-sub">${escapeHtml(s.description || "")}</div>` +
          `<div class="item-sub">${escapeHtml(s.path || "")}</div>` +
        `</div>` +
        `<div class="item-actions"></div>`;
      const acciones = li.querySelector(".item-actions");
      const ver = document.createElement("button");
      ver.className = "btn-mini";
      ver.textContent = "ver";
      ver.addEventListener("click", async () => {
        const pre = $("skill-contenido");
        pre.hidden = false;
        pre.textContent = "cargando…";
        try {
          const det = await wsCall(`/api/skills/${encodeURIComponent(s.name)}`);
          pre.textContent = det.content || "(vacío)";
        } catch (e) { pre.textContent = `[!] ${e.message}`; }
      });
      acciones.appendChild(ver);
      acciones.appendChild(botonBorrar(async () => {
        try {
          await wsDelete(`/api/skills/${encodeURIComponent(s.name)}`);
          $("skill-contenido").hidden = true;
          cargarSkills();
        } catch (e) { toast(e.message, false); }
      }));
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = liVacio(`[!] ${e.message}`);
  }
}

async function crearSkill() {
  try {
    await wsPost("/api/skills", {
      name: $("skill-nombre").value,
      description: $("skill-desc").value,
      content: $("skill-contenido-nuevo").value,
    });
    $("skill-nombre").value = $("skill-desc").value = "";
    $("skill-contenido-nuevo").value = "";
    setStatusLine("skill-status", "[OK] skill creada");
    cargarSkills();
  } catch (e) {
    setStatusLine("skill-status", `[X] ${e.message}`);
  }
}

/* ── [T] Tareas ── */

const ESTADOS_TAREA = [
  ["pendiente", "pendiente"],
  ["en_curso", "en curso"],
  ["hecha", "hecha"],
];

async function cargarTareas() {
  const ul = $("tareas-list");
  ul.innerHTML = liVacio("cargando…");
  try {
    const r = await wsCall("/api/tareas");
    const ts = r.tareas || [];
    ul.innerHTML = ts.length ? "" : liVacio("(sin tareas)");
    for (const t of ts) {
      const li = document.createElement("li");
      li.className = "item" + (t.estado === "hecha" ? " off" : "");
      li.innerHTML =
        `<div class="item-main">` +
          `<div class="item-title">${escapeHtml(t.titulo)}</div>` +
          (t.notas ? `<div class="item-sub">${escapeHtml(t.notas)}</div>` : "") +
          `<div class="item-sub">${escapeHtml(String(t.creada || ""))}</div>` +
        `</div>` +
        `<div class="item-actions"></div>`;
      const acciones = li.querySelector(".item-actions");
      const sel = document.createElement("select");
      sel.className = "input-line";
      sel.style.width = "auto";
      for (const [val, label] of ESTADOS_TAREA) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = label;
        if (t.estado === val) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", async () => {
        try {
          await wsCall(`/api/tareas/${t.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ estado: sel.value }),
          });
          cargarTareas();
        } catch (e) { toast(e.message, false); }
      });
      acciones.appendChild(sel);
      acciones.appendChild(botonBorrar(async () => {
        try {
          await wsDelete(`/api/tareas/${t.id}`);
          cargarTareas();
        } catch (e) { toast(e.message, false); }
      }));
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = liVacio(`[!] ${e.message}`);
  }
}

async function agregarTarea() {
  try {
    await wsPost("/api/tareas", {
      titulo: $("tarea-titulo").value,
      notas: $("tarea-notas").value,
    });
    $("tarea-titulo").value = $("tarea-notas").value = "";
    setStatusLine("tarea-status", "[OK] agregada");
    cargarTareas();
  } catch (e) {
    setStatusLine("tarea-status", `[X] ${e.message}`);
  }
}

/* ── Importar memoria de otra IA (prompt → JSON → recuerdos) ──
   Flujo roundtrip: GET /api/memory/import-prompt para copiar el prompt de
   extracción → el usuario se lo pega a otra IA → pega la respuesta JSON y
   POST /api/memory/import-text la importa (dedupe + resumen sumado). */

async function obtenerPromptImport() {
  try {
    const r = await wsCall("/api/memory/import-prompt");
    $("mem-import-prompt").textContent = r.prompt || "";
    $("mem-import-prompt").hidden = false;
    $("btn-mem-copy-prompt").hidden = false;
  } catch (e) { toast(`No se pudo generar el prompt: ${e.message}`, false); }
}

async function copiarPromptImport() {
  const texto = $("mem-import-prompt").textContent;
  if (!texto) return;
  try {
    await navigator.clipboard.writeText(texto);
    toast("Prompt copiado — pegáselo a la otra IA");
  } catch {
    /* Clipboard API puede fallar sin contexto seguro: fallback a selección. */
    const sel = window.getSelection();
    sel.selectAllChildren($("mem-import-prompt"));
    toast("Seleccionado — copialo con Ctrl+C");
  }
}

async function importarMemoria() {
  const texto = $("mem-import-text").value.trim();
  if (!texto) { setStatusLine("mem-import-status", "[!] pegá primero la respuesta de la otra IA"); return; }
  setStatusLine("mem-import-status", "importando…");
  try {
    const r = await wsPost("/api/memory/import-text", { texto });
    if (r.ok === false) throw new Error(r.error || "falló la importación");
    const partes = [
      `${r.recuerdos_importados} recuerdo(s) importado(s)`,
      r.duplicados_salteados ? `${r.duplicados_salteados} duplicado(s) salteado(s)` : "",
      r.resumen_agregado ? "resumen actualizado" : "",
      (r.errores && r.errores.length) ? `${r.errores.length} con error` : "",
    ].filter(Boolean);
    setStatusLine("mem-import-status", `[OK] ${partes.join(" · ")}`);
    toast(`Memoria importada: ${partes.join(", ")}`);
    $("mem-import-text").value = "";
    cargarMemoria();   // refresca resumen + recuerdos ya importados
  } catch (e) {
    setStatusLine("mem-import-status", `[X] ${e.message}`);
    toast(`Importación falló: ${e.message}`, false);
  }
}

/* ── [M] MCPs (mcp_servers.json — el mismo archivo del /mcps de la TUI) ── */

const MCP_MASK = "********";   // espejo del _MASK del backend

function parseEnvLines(txt) {
  const env = {};
  for (const linea of (txt || "").split("\n")) {
    const t = linea.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const idx = t.indexOf("=");
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

async function cargarMcps() {
  const ul = $("mcps-list");
  ul.innerHTML = liVacio("cargando…");
  try {
    const r = await wsCall("/api/mcps");
    const servers = r.servers || [];
    ul.innerHTML = servers.length ? "" : liVacio("(sin servers MCP configurados)");
    for (const s of servers) pintarFilaMcp(ul, s);
  } catch (e) {
    ul.innerHTML = liVacio(`[!] ${e.message}`);
  }
}

function pintarFilaMcp(ul, s) {
  const li = document.createElement("li");
  li.className = "item" + (s.enabled ? "" : " off");
  const envTags = Object.entries(s.env || {})
    .map(([k, v]) =>
      `<span class="tag" title="enmascarado">${escapeHtml(k)}${v.preview ? ` ${escapeHtml(v.preview)}` : ""}</span>`)
    .join(" ");
  li.innerHTML =
    `<div class="item-main">` +
      `<div class="item-title">${escapeHtml(s.name)} ` +
        `<span class="tag ${s.enabled ? "teal" : ""}">${s.enabled ? "activo" : "off"}</span></div>` +
      `<div class="item-sub">${escapeHtml(s.transport)} · ${escapeHtml(s.command)} ` +
        `${escapeHtml((s.args || []).join(" "))}</div>` +
      (envTags ? `<div class="item-sub">${envTags}</div>` : "") +
    `</div>` +
    `<div class="item-actions"></div>`;

  const acciones = li.querySelector(".item-actions");

  /* Toggle enabled: PATCH mandando el env con el mask — el backend conserva
     los valores reales (ver mcp_routes._resolver_env). */
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "toggle";
  toggle.checked = !!s.enabled;
  toggle.title = "Activar/desactivar (como /mcps de la TUI)";
  toggle.addEventListener("change", async () => {
    try {
      await wsCall(`/api/mcps/${encodeURIComponent(s.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: s.args,
          env: Object.fromEntries(Object.keys(s.env || {}).map((k) => [k, MCP_MASK])),
          enabled: toggle.checked,
        }),
      });
      toast(`${s.name}: ${toggle.checked ? "activado" : "desactivado"}`);
      cargarMcps();
    } catch (e) { toast(e.message, false); cargarMcps(); }
  });

  const editar = document.createElement("button");
  editar.className = "btn-mini";
  editar.textContent = "editar";
  editar.title = "Editar (token revocado o vencido, command, args, renombrar…)";
  editar.addEventListener("click", () => abrirEdicionMcp(s));

  const tools = document.createElement("button");
  tools.className = "btn-mini";
  tools.textContent = "tools";
  tools.title = "Listar las tools que expone (conecta al server en vivo)";
  tools.addEventListener("click", async () => { verToolsMcp(s.name); });

  acciones.appendChild(toggle);
  acciones.appendChild(editar);
  acciones.appendChild(tools);
  acciones.appendChild(botonBorrar(async () => {
    try {
      await wsDelete(`/api/mcps/${encodeURIComponent(s.name)}`);
      cargarMcps();
    } catch (e) { toast(e.message, false); }
  }));
  ul.appendChild(li);
}

async function verToolsMcp(nombre) {
  /* Panel de tools bajo la lista (se crea una sola vez). */
  let pre = $("mcp-tools-view");
  if (!pre) {
    pre = document.createElement("pre");
    pre.id = "mcp-tools-view";
    pre.className = "prompt-preview";
    const tab = $("wtab-mcps");
    tab.insertBefore(pre, tab.querySelector(".block-new"));
  }
  pre.hidden = false;
  pre.textContent = `Conectando a '${nombre}'… (puede tardar la 1ra vez)`;
  try {
    const r = await wsCall(`/api/mcps/${encodeURIComponent(nombre)}/tools`);
    if (r.ok === false) { pre.textContent = `[!] ${r.error}`; return; }
    const tools = r.tools || [];
    pre.textContent = tools.length
      ? tools.map((t) => `• ${t.name || "?"}\n  ${(t.description || "").split("\n")[0]}`).join("\n")
      : "(el server no expone tools)";
  } catch (e) {
    pre.textContent = `[!] ${e.message}`;
  }
}

/* ── Edición de MCP: el mismo form sirve para alta (POST) y edición (PATCH).
   El env se precarga con los valores ENMASCARADOS: al guardar, el backend
   conserva los reales para las claves que queden con el mask — y si el
   token se revocó/venció solo hay que escribir el valor nuevo en esa línea.
   (ver backend/api/routes/mcp_routes.py::_resolver_env) ── */

let mcpEditTarget = null;   // nombre del server en edición (null = alta nueva)

function abrirEdicionMcp(s) {
  /* Si se llamó desde el menú [+], abrir el workspace ya en la tab MCPs. */
  if ($("workspace-modal").hidden) abrirWorkspace("wtab-mcps");
  mcpEditTarget = s.name;
  $("mcp-nombre").value = s.name || "";
  $("mcp-transport").value = s.transport || "stdio";
  $("mcp-command").value = s.command || "";
  $("mcp-args").value = (s.args || []).join(" ");
  $("mcp-env").value = Object.keys(s.env || {})
    .map((k) => `${k}=${MCP_MASK}`)
    .join("\n");
  $("mcp-form-details").open = true;
  $("mcp-form-title").textContent = `Editando: ${s.name}`;
  $("btn-add-mcp").textContent = "Guardar cambios";
  $("btn-mcp-cancel-edit").hidden = false;
  setStatusLine("mcp-status",
    "las claves enmascaradas conservan su valor — escribí el token nuevo solo donde cambió");
}

function cancelarEdicionMcp() {
  mcpEditTarget = null;
  $("mcp-nombre").value = $("mcp-command").value = "";
  $("mcp-args").value = $("mcp-env").value = "";
  $("mcp-transport").value = "stdio";
  $("mcp-form-title").textContent = "Agregar MCP custom";
  $("btn-add-mcp").textContent = "Agregar MCP";
  $("btn-mcp-cancel-edit").hidden = true;
}

async function agregarMcp() {
  const body = {
    name: $("mcp-nombre").value.trim(),
    transport: $("mcp-transport").value.trim() || "stdio",
    command: $("mcp-command").value.trim(),
    args: $("mcp-args").value.trim().split(/\s+/).filter(Boolean),
    env: parseEnvLines($("mcp-env").value),
    enabled: true,
  };
  try {
    if (mcpEditTarget) {
      await wsCall(`/api/mcps/${encodeURIComponent(mcpEditTarget)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setStatusLine("mcp-status", `[OK] '${body.name}' actualizado`);
      toast(`MCP '${body.name}' actualizado`);
      cancelarEdicionMcp();
    } else {
      await wsPost("/api/mcps", body);
      $("mcp-nombre").value = $("mcp-command").value = "";
      $("mcp-args").value = $("mcp-env").value = "";
      setStatusLine("mcp-status", "[OK] MCP agregado");
    }
    cargarMcps();
  } catch (e) {
    setStatusLine("mcp-status", `[X] ${e.message}`);
  }
}

/* ── [R] Roblox (el /play-roblox de la TUI) ── */

async function cargarRoblox() {
  try {
    const r = await wsCall("/api/roblox/status");
    pintarRoblox(r);
  } catch (e) {
    $("roblox-estado").textContent = `[!] ${e.message}`;
  }
}

function pintarRoblox(r) {
  const on = !!r.running;
  $("roblox-estado").textContent = on ? "• ACTIVO" : "○ inactivo";
  $("roblox-estado").className = on ? "on" : "";
  $("roblox-provider").textContent = r.provider || "—";
  $("roblox-pid").textContent = r.pid ?? "—";
  if (on && r.provider) $("roblox-provider-select").value = r.provider;
  $("btn-roblox-start").disabled = on;
  $("btn-roblox-stop").disabled = !on;
}

async function controlRoblox(accion) {
  setStatusLine("roblox-status", accion === "stop" ? "deteniendo…" : "iniciando…");
  try {
    const r = await wsPost("/api/roblox", {
      action: accion,
      provider: $("roblox-provider-select").value,
    });
    setStatusLine("roblox-status", `${r.ok ? "[OK]" : "[!]"} ${r.message}`);
    pintarRoblox(r);
    toast(r.message, !!r.ok);
  } catch (e) {
    setStatusLine("roblox-status", `[X] ${e.message}`);
  }
}

/* ── [E] Effort & Agente (el /effort y /agents de la TUI) ── */

/* Espejo del EFFORT_MAP del backend (runtime_routes.py) — solo para pintar
   las tarjetas; el valor que cuenta lo aplica el backend al hacer POST. */
const WEB_EFFORT_MAP = {
  low:    { temp: 0.9,  ctx: "4k",  predict: 768 },
  medium: { temp: 0.6,  ctx: "8k",  predict: 2048 },
  high:   { temp: 0.35, ctx: "16k", predict: 4096 },
  max:    { temp: 0.15, ctx: "32k", predict: 8192 },
};

async function cargarEffortYAgentes() {
  let effortActual = "medium";
  let agenteActual = "build";
  let agentes = [];
  try {
    const r = await wsCall("/api/effort");
    if (r.effort) effortActual = r.effort;
  } catch { /* default medium */ }
  try {
    const r = await wsCall("/api/agents");
    if (r.agent) agenteActual = r.agent;
    if (r.agents && r.agents.length) agentes = r.agents;
  } catch { /* defaults */ }

  const grid = $("effort-grid");
  grid.innerHTML = "";
  for (const [nivel, p] of Object.entries(WEB_EFFORT_MAP)) {
    const card = document.createElement("button");
    card.className = "effort-card" + (nivel === effortActual ? " active" : "");
    card.innerHTML =
      `<span class="effort-name">${nivel}</span>` +
      `<span class="effort-params">temp ${p.temp} · ctx ${p.ctx} · ${p.predict} tok</span>`;
    card.addEventListener("click", () => setEffort(nivel));
    grid.appendChild(card);
  }

  const gAgents = $("agents-grid");
  gAgents.innerHTML = "";
  for (const a of agentes) {
    const card = document.createElement("button");
    card.className = "effort-card" + (a.name === agenteActual ? " active" : "");
    card.innerHTML =
      `<span class="effort-name">${escapeHtml(a.name)}</span>` +
      `<span class="effort-params">${escapeHtml(a.descripcion || a.kind || "")}</span>`;
    card.addEventListener("click", () => setAgente(a.name));
    gAgents.appendChild(card);
  }
}

async function setEffort(nivel) {
  setStatusLine("effort-status", "aplicando…");
  try {
    const r = await wsPost("/api/effort", { effort: nivel });
    if (r.ok === false) throw new Error(r.error || "no se pudo aplicar");
    setStatusLine("effort-status", `[OK] effort=${nivel} (efecto inmediato)`);
    toast(`Effort: ${nivel}`);
    cargarEffortYAgentes();
    refrescarStatus();
  } catch (e) {
    setStatusLine("effort-status", `[X] ${e.message}`);
  }
}

async function setAgente(nombre) {
  setStatusLine("effort-status", "aplicando…");
  try {
    const r = await wsPost("/api/agent", { agent: nombre });
    if (r.ok === false) throw new Error(r.error || "no se pudo aplicar");
    setStatusLine("effort-status", `[OK] agente=${nombre}`);
    toast(`Agente: ${nombre}`);
    cargarEffortYAgentes();
    refrescarStatus();
  } catch (e) {
    setStatusLine("effort-status", `[X] ${e.message}`);
  }
}

// Crear agente custom (POST /api/agents) y activarlo en el momento
// (sin esto, recién creado "no hacía nada": /api/agent solo aceptaba
// los nativos — arreglado en el backend también).
async function crearAgenteCustom() {
  // OJO: nunca llamar la variable local "prompt" — shadowea window.prompt y
  // TODAS las llamadas prompt() del scope revientan con TDZ ("Cannot access
  // 'prompt' before initialization"). Por eso antes este flujo no hacía nada.
  const name = window.prompt("Nombre del agente (minúsculas, números, guiones):");
  if (!name) return;
  const descripcion = window.prompt("Descripción:") || "";
  const promptTexto = window.prompt("Prompt del sistema (opcional):") || "";
  const modelo = window.prompt("Modelo preferido (ej. ornith:9b, vacío = default):") || "";
  const toolsInput = window.prompt("Tools permitidas (coma-separadas, ej. move,press,look):") || "";
  const tools = toolsInput.split(",").map(t => t.trim()).filter(Boolean);
  const nombre = name.trim().toLowerCase();

  try {
    const r = await wsPost("/api/agents", {
      name: nombre,
      descripcion,
      prompt: promptTexto,
      modelo: modelo.trim(),
      tools,
    });
    if (!r.ok) throw new Error(r.error || "No se pudo crear");
    /* Activarlo en el momento: es lo que el usuario espera al crearlo. */
    const activ = await wsPost("/api/agent", { agent: nombre });
    if (!activ.ok) throw new Error(activ.error || "creado pero no se pudo activar");
    toast(`Agente '${nombre}' creado y activado`);
    cargarEffortYAgentes();
    refrescarStatus();
    if (!$("attach-menu").hidden) refrescarResumenesMenu();
    if (!$("am-agents-list").closest(".atview").hidden) cargarMenuAgentes();
  } catch (e) {
    toast(`Error: ${e.message}`, false);
  }
}

// Cargar datos de la cuenta (perfil + preferencias)
async function cargarCuenta() {
  try {
    const [profileRes, prefsRes] = await Promise.all([
      wsCall("/api/account/profile"),
      wsCall("/api/account/preferences"),
    ]);
    if (profileRes.ok) {
      const p = profileRes.profile || {};
      $("acc-nombre").value = p.nombre || "";
      $("acc-bio").value = p.bio || "";
      $("acc-timezone").value = p.timezone || "America/Argentina/Buenos_Aires";
      $("acc-idioma").value = p.idioma || "es";
      $("acc-genero").value = p.genero || "";
      $("acc-pronombre").value = p.pronombre_custom || "";
      $("acc-pronombre-row").hidden = (p.genero || "") !== "otro";
      $("acc-nacimiento").value = p.fecha_nacimiento || "";
      if (p.avatar_url) {
        $("avatar-preview").src = p.avatar_url;
        $("avatar-preview").hidden = false;
      } else {
        $("avatar-preview").hidden = true;
      }
    }
    if (prefsRes.ok) {
      const p = prefsRes.preferences || {};
      $("pref-tema").value = p.tema || "dark";
      $("pref-idioma").value = p.idioma_ui || "es";
      $("pref-compacto").checked = p.modo_compacto || false;
      $("pref-notif").checked = p.notificaciones_push !== false;
    }
  } catch (e) {
    console.error("Error cargando cuenta:", e);
  }
}

/* ── Abrir/cerrar el workspace + mapa tab → loader ── */

const WS_LOADERS = {
  "wtab-proyectos": cargarProyectos,
  "wtab-memoria": cargarMemoria,
  "wtab-skills": cargarSkills,
  "wtab-tareas": cargarTareas,
  "wtab-mcps": cargarMcps,
  "wtab-roblox": cargarRoblox,
  "wtab-effort": cargarEffortYAgentes,
};

function abrirWorkspace(tabId) {
  const modal = $("workspace-modal");
  modal.hidden = false;
  activarTabWorkspace(tabId || "wtab-proyectos");
}

function cerrarWorkspace() { $("workspace-modal").hidden = true; }

function activarTabWorkspace(tabId) {
  const modal = $("workspace-modal");
  modal.querySelectorAll(".modal-tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.wtab === tabId));
  modal.querySelectorAll(".tab-body").forEach((b) => { b.hidden = b.id !== tabId; });
  (WS_LOADERS[tabId] || (() => {}))();
}


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
$("btn-models").addEventListener("click", async () => {
  /* Antes el toast de éxito se mostraba SIEMPRE, incluso con el backend
     offline (feedback falso). Ahora depende del resultado real. */
  const ok = await cargarModelos();
  toast(ok ? "Modelos actualizados" : "Sin conexión con el backend", ok);
});
$("btn-refresh-sessions").addEventListener("click", cargarSesiones);
$("btn-close-settings").addEventListener("click", cerrarSettings);
$("settings-modal").addEventListener("click", (e) => {
  if (e.target === $("settings-modal")) cerrarSettings();
});
$("btn-save-tui").addEventListener("click", guardarConfigTUI);
$("btn-save-account").addEventListener("click", guardarCuenta);
$("btn-save-prefs").addEventListener("click", guardarPreferencias);
$("btn-avatar-upload").addEventListener("click", () => $("avatar-input").click());
$("avatar-input").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
    toast("Formato no soportado (jpg, png, webp, gif)", false);
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast("Máximo 2 MB", false);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    $("avatar-preview").src = reader.result;
    $("avatar-preview").hidden = false;
  };
  reader.readAsDataURL(file);
});
$("avatar-input").addEventListener("change", (e) => e.target.value = "");
$("btn-save-prompt").addEventListener("click", guardarSystemPrompt);
$("btn-preview-prompt").addEventListener("click", previewSystemPrompt);

/* Menú de attach ([+]): popup con archivo/foto/cámara/dictado/MCPs/agentes/
   skills. El input de archivo y foto quedan como acciones del menú. */
$("btn-attach").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("attach-menu").hidden) abrirAttachMenu(); else cerrarAttachMenu();
});
$("file-input").addEventListener("change", (e) => {
  agregarAdjuntos(Array.from(e.target.files || []));
  e.target.value = "";   // permite re-adjuntar el mismo archivo
});
$("photo-input").addEventListener("change", (e) => {
  agregarAdjuntos(Array.from(e.target.files || []));
  e.target.value = "";
});
$("btn-mic").addEventListener("click", toggleMic);

/* Acciones del root del menú */
document.querySelectorAll("[data-am-action]").forEach((b) => {
  b.addEventListener("click", () => {
    const acc = b.dataset.amAction;
    if (acc === "file") { cerrarAttachMenu(); $("file-input").click(); }
    else if (acc === "photo") { cerrarAttachMenu(); $("photo-input").click(); }
    else if (acc === "camera") { cerrarAttachMenu(); abrirCamara(); }
    else if (acc === "voice") { cerrarAttachMenu(); toggleMic(); }
    else if (acc === "mcps-manage") { cerrarAttachMenu(); abrirWorkspace("wtab-mcps"); }
    else if (acc === "agents-manage") { cerrarAttachMenu(); abrirWorkspace("wtab-effort"); }
    /* agent-new: el menú QUEDA ABIERTO (agente creado se ve al instante en
       la vista Agentes; la creación refresca la lista vía cargarMenuAgentes). */
    else if (acc === "agent-new") { crearAgenteCustom(); }
    else if (acc === "skills-manage") { cerrarAttachMenu(); abrirWorkspace("wtab-skills"); }
  });
});
document.querySelectorAll("[data-am-view]").forEach((b) => {
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    mostrarVistaAttach(b.dataset.amView);
  });
});
document.querySelectorAll("[data-am-back]").forEach((b) => {
  b.addEventListener("click", () => mostrarVistaAttach("root"));
});
/* Click fuera del menú lo cierra */
document.addEventListener("click", (e) => {
  if (!$("attach-menu").hidden && !e.target.closest(".menu-anchor")) {
    cerrarAttachMenu();
  }
});

/* Drag & Drop en el composer y área de mensajes */
const chatEl = $("chat");
["dragenter", "dragover"].forEach((evt) => {
  chatEl.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatEl.classList.add("drag-over");
  });
});
["dragleave", "drop"].forEach((evt) => {
  chatEl.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatEl.classList.remove("drag-over");
  });
});
chatEl.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) agregarAdjuntos(files);
});

/* Drag & Drop de skills: soltar un .md/.txt sobre el tab de Skills del
   workspace importa el archivo al formulario de creación (respeta el
   frontmatter name/description si lo trae). Antes apuntaba a un modal
   ($("skill-modal")) que no existe — nunca hacía nada. */
const skillTab = $("wtab-skills");
skillTab.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  skillTab.classList.add("drag-over");
});
["dragleave", "drop"].forEach((evt) => {
  skillTab.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    skillTab.classList.remove("drag-over");
  });
});
skillTab.addEventListener("drop", async (e) => {
  const f = Array.from(e.dataTransfer.files || [])
    .find((x) => /\.(md|markdown|txt)$/i.test(x.name));
  if (!f) {
    toast("Soltá un archivo .md/.txt con la skill (idealmente con frontmatter)", false);
    return;
  }
  let cuerpo = (await f.text()).trim();
  /* Frontmatter simple: ---\n  name: x\n  description: y\n--- */
  let nombre = "", desc = "";
  const m = cuerpo.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    const fm = m[1];
    const nm = fm.match(/^name:\s*(.+)$/m);
    const ds = fm.match(/^description:\s*(.+)$/m);
    nombre = nm ? nm[1].trim() : "";
    desc = ds ? ds[1].trim() : "";
    cuerpo = m[2].trim();
  }
  if (!nombre) {
    nombre = f.name.replace(/\.(md|markdown|txt)$/i, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  $("skill-nombre").value = nombre;
  $("skill-desc").value = desc;
  $("skill-contenido-nuevo").value = cuerpo;
  $("skill-form-details").open = true;
  toast(`Skill '${nombre}' cargada — revisá y tocá "Crear skill"`);
  if (!desc) toast("Le falta la descripción (obligatoria)", false);
});

/* Workspace: sidebar abre el modal en la tab correspondiente */
document.querySelectorAll("[data-wtab].nav-item").forEach((item) => {
  item.addEventListener("click", () => abrirWorkspace(item.dataset.wtab));
});

/* Settings modal tabs (TUI, System Prompt, Account) */
document.querySelectorAll("[data-tab].tab").forEach((item) => {
  item.addEventListener("click", () => activarTabSettings(item.dataset.tab));
});

function activarTabSettings(tabId) {
  const modal = $("settings-modal");
  modal.querySelectorAll(".modal-tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tabId));
  modal.querySelectorAll(".tab-body").forEach((b) => { b.hidden = b.id !== tabId; });
  const loader = { "tab-tui": cargarConfigUI, "tab-prompt": cargarSystemPrompt, "tab-account": cargarCuenta };
  (loader[tabId] || (() => {}))();
}

$("btn-close-workspace").addEventListener("click", cerrarWorkspace);
$("workspace-modal").addEventListener("click", (e) => {
  if (e.target === $("workspace-modal")) cerrarWorkspace();
});

/* Botones del workspace */
$("btn-add-proyecto").addEventListener("click", agregarProyecto);
$("btn-guardar-memoria").addEventListener("click", guardarMemoria);
$("btn-consolidar").addEventListener("click", consolidarMemoria);
$("btn-add-recuerdo").addEventListener("click", agregarRecuerdo);
$("btn-add-skill").addEventListener("click", crearSkill);
$("btn-add-tarea").addEventListener("click", agregarTarea);
$("btn-add-mcp").addEventListener("click", agregarMcp);
$("btn-mcp-cancel-edit").addEventListener("click", cancelarEdicionMcp);
$("btn-mem-import-prompt").addEventListener("click", obtenerPromptImport);
$("btn-mem-copy-prompt").addEventListener("click", copiarPromptImport);
$("btn-mem-import").addEventListener("click", importarMemoria);
$("btn-save-cfg-extra").addEventListener("click", guardarConfigExtra);
$("btn-cfg-extra-reload").addEventListener("click", cargarConfigExtra);
$("btn-roblox-start").addEventListener("click", () => controlRoblox("start"));
$("btn-roblox-stop").addEventListener("click", () => controlRoblox("stop"));
$("btn-roblox-refresh").addEventListener("click", cargarRoblox);
$("btn-create-agent").addEventListener("click", crearAgenteCustom);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    cerrarAttachMenu();
    cerrarCamara();
    cancelarMic();       // si estaba grabando, corta sin transcribir
    cerrarSettings();
    cerrarWorkspace();
  }
});

/* Cuenta: el pronombre custom solo aparece con género "otro" */
$("acc-genero").addEventListener("change", () => {
  $("acc-pronombre-row").hidden = $("acc-genero").value !== "otro";
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
