/**
 * reasoning_block.js — Componente unificado de ESTADO + RAZONAMIENTO.
 *
 * Una sola pieza de UI: la cabecera muestra el estado dinámico de Aether
 * ("✦ Husmeando...", "✦ Ejecutando herramienta: shell...") y funciona como
 * toggle: al click, el razonamiento se despliega debajo con animación.
 * Al terminar, la cabecera pasa a "✓ Completado" y el razonamiento queda
 * disponible para expandir/contraer. Sin razonamiento no hay bloque.
 *
 * Contrato de eventos del backend (SSE /api/chat/stream y WS /ws/chat):
 *   {"type":"start"}                     → bloque live ("Pensando...")
 *   {"type":"node",    "estado": "..."}  → actualiza la cabecera de estado
 *   {"type":"reasoning","data": "frag"}  → agrega fragmento al razonamiento
 *   {"type":"token",   "data": "frag"}   → respuesta final (stream aparte)
 *   {"type":"done",    "response": ..., "reasoning": "..."} → termina
 *
 * DATOS SEPARADOS: este componente SOLO consume el canal "reasoning" (y
 * done.reasoning como fuente autoritativa final). JAMÁS parsea los tokens
 * de la respuesta para detectar razonamiento: esa separación la hace el
 * backend (ReasoningEvent, ver core/agent/streaming.py).
 *
 * El razonamiento tampoco pasa por el panel de logs (agregarLogLinea): es
 * un canal visual propio, separado de respuesta, logs, tools y usuario.
 *
 * Lógica pura (crearEstado/aplicar*) + render (crearBloque) separados para
 * que los tests de node (--test) cubran el comportamiento sin DOM.
 */

(function (global) {
  "use strict";

  /* ══════ Lógica pura (testeable) ══════ */

  // Estados GENÉRICOS del planner → verbos con personalidad (variedad:
  // "Husmeando...", "Cocinando..."). Los estados ESPECÍFICOS de
  // herramienta/etapa ("Ejecutando herramienta: shell", "Consultando la
  // web...", "Razonando qué herramienta usar...") se respetan tal cual.
  var RE_GENERICO = /pensando|decidiendo|preparando contexto|analizando solicitud/i;

  var VERBOS_TRABAJO = [
    "Pensando", "Husmeando", "Analizando", "Inspeccionando", "Investigando",
    "Cocinando", "Ideando", "Masticando", "Maquinando", "Explorando",
  ];

  function limpiarEstadoTUI(texto) {
    // El backend (status_messages.py) manda prefijos de la TUI: "[•] ...".
    return String(texto || "").replace(/^\[[^\]]{1,2}\]\s*/, "").trim();
  }

  function esEstadoGenerico(texto) {
    return RE_GENERICO.test(texto);
  }

  function verboVariado(seed) {
    return VERBOS_TRABAJO[Math.abs(seed) % VERBOS_TRABAJO.length];
  }

  function estadoDisplay(estadoTexto, seed, live) {
    var limpio = limpiarEstadoTUI(estadoTexto);
    if (!limpio) return live ? "Pensando..." : "Completado";
    if (live && esEstadoGenerico(limpio)) return verboVariado(seed) + "...";
    if (live && !/[.….]$/.test(limpio)) return limpio + "...";
    return limpio;
  }

  function crearEstado() {
    // Modelo GenerationState (spec): isGenerating NUNCA depende de hasReasoning.
    // El answer buffer vive aparte (app.js): este componente solo es dueño
    // del status + reasoning, los tres flujos están separados.
    return {
      isGenerating: true,   // generando: shimmer + dots en la cabecera
      error: false,
      status: "Pensando",   // texto de la cabecera mientras genera
      updates: 0,           // contador de cambios de estado (seed de verbos)
      reasoning: "",        // razonamiento acumulado (canal dedicado)
      reasoningDone: false, // el razonamiento ya terminó de llegar
      expandido: false,     // intención del usuario (toggle)
    };
  }

  function aplicarStatus(estado, estadoTexto) {
    estado.updates += 1;
    estado.status = estadoDisplay(estadoTexto, estado.updates, estado.isGenerating);
  }

  function aplicarReasoning(estado, fragmento) {
    if (typeof fragmento === "string" && fragmento) estado.reasoning += fragmento;
  }

  function finalizar(estado, razonamientoFinal) {
    estado.isGenerating = false;
    estado.reasoningDone = true;
    // Etiqueta final estilo Open WebUI: "Pensó" (pasado), con el razonamiento
    // desplegable debajo. La respuesta (answer) es otro buffer: no se toca.
    estado.status = "Pensó";
    // done.reasoning es la fuente autoritativa del backend (acumulado del
    // turno): si el cliente perdió fragmentos, gana la del backend.
    if (typeof razonamientoFinal === "string" && razonamientoFinal.trim()
        && razonamientoFinal !== estado.reasoning) {
      estado.reasoning = razonamientoFinal;
    }
  }

  function marcarError(estado) {
    estado.isGenerating = false;
    estado.reasoningDone = true;
    estado.error = true;
    estado.status = "Error";
  }

  function toggleExpandido(estado) {
    estado.expandido = !estado.expandido;
    return estado.expandido;
  }

  function tieneRazonamiento(estado) {
    // spec: "si reasoning.trim() está vacío → no mostrar control de reasoning"
    return estado.reasoning.trim() !== "";
  }

  function debeDescartarBloque(estado) {
    // Terminó (o falló) SIN razonamiento real: nada que expandir → el bloque
    // no aporta (no queda un toggle inútil). El estado YA cumplió su función
    // de indicar actividad mientras Aether generaba.
    return !estado.isGenerating && !tieneRazonamiento(estado);
  }

  /* ══════ Render DOM ══════ */

  function _el(clase, tag) {
    var el = document.createElement(tag || "div");
    if (clase) el.className = clase;
    return el;
  }

  /**
   * Crea el bloque unificado montado en el DOM.
   * Devuelve una API para el flujo de streaming:
   *   { root, estado, setStatus, pushReasoning, finalizar, error, toggle, reasoning }
   */
  function crearBloque() {
    var estado = crearEstado();

    var root = _el("agent-block live");
    var head = _el("agent-head", "button");
    head.type = "button";
    head.title = "Razonamiento del modelo";

    var spk = _el("agent-spk", "span");
    spk.textContent = "✦";
    var statusEl = _el("agent-status", "span");
    statusEl.textContent = "Pensando...";
    var dots = _el("agent-dots", "span");
    dots.appendChild(_el("", "i"));
    dots.appendChild(_el("", "i"));
    dots.appendChild(_el("", "i"));
    var chev = _el("agent-chev", "span");
    chev.textContent = "˅";

    head.appendChild(spk);
    head.appendChild(statusEl);
    head.appendChild(dots);
    head.appendChild(chev);

    var bodyWrap = _el("agent-body-wrap");
    var body = _el("agent-body");
    var bodyContent = _el("agent-body-content");
    body.appendChild(bodyContent);
    bodyWrap.appendChild(body);

    root.appendChild(head);
    root.appendChild(bodyWrap);

    function pintar() {
      statusEl.textContent = estado.status;
      root.classList.toggle("live", estado.isGenerating);
      root.classList.toggle("done", !estado.isGenerating && !estado.error);
      root.classList.toggle("error", estado.error);
      root.classList.toggle("open", estado.expandido && tieneRazonamiento(estado));
      root.classList.toggle("has-reasoning", tieneRazonamiento(estado));
      spk.textContent = !estado.isGenerating && !estado.error ? "✓" : "✦";
      if (estado.expandido && tieneRazonamiento(estado)) {
        bodyContent.textContent = estado.reasoning;
        bodyContent.scrollTop = bodyContent.scrollHeight;
      }
    }

    head.addEventListener("click", function () {
      toggleExpandido(estado);
      pintar();
    });

    var api = {
      root: root,
      estado: estado,
      setStatus: function (estadoTexto) { aplicarStatus(estado, estadoTexto); pintar(); },
      pushReasoning: function (frag) { aplicarReasoning(estado, frag); pintar(); },
      finalizar: function (razonamientoFinal) { finalizar(estado, razonamientoFinal); pintar(); },
      error: function () { marcarError(estado); pintar(); },
      toggle: function () { toggleExpandido(estado); pintar(); },
      reasoning: function () { return estado.reasoning; },
    };
    pintar();
    return api;
  }

  /**
   * Monta un bloque ya TERMINADO (mensajes del historial persistido con
   * reasoning). Sin reasoning → devuelve null (no se crea bloque vacío).
   */
  function crearBloqueHistorial(reasoning) {
    if (!reasoning) return null;
    var bloque = crearBloque();
    aplicarReasoning(bloque.estado, reasoning);
    bloque.finalizar(reasoning);
    return bloque;
  }

  /* ══════ Exports (browser: window.ReasoningBlock; node: module.exports) ══════ */

  var API = {
    VERBOS_TRABAJO: VERBOS_TRABAJO,
    limpiarEstadoTUI: limpiarEstadoTUI,
    esEstadoGenerico: esEstadoGenerico,
    verboVariado: verboVariado,
    estadoDisplay: estadoDisplay,
    crearEstado: crearEstado,
    aplicarStatus: aplicarStatus,
    aplicarReasoning: aplicarReasoning,
    finalizar: finalizar,
    marcarError: marcarError,
    toggleExpandido: toggleExpandido,
    debeDescartarBloque: debeDescartarBloque,
    tieneRazonamiento: tieneRazonamiento,
    crearBloque: typeof document !== "undefined" ? crearBloque : null,
    crearBloqueHistorial: typeof document !== "undefined" ? crearBloqueHistorial : null,
  };

  global.ReasoningBlock = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
