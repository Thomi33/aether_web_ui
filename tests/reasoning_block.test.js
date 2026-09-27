/**
 * Tests del componente unificado de estado + razonamiento
 * (web/reasoning_block.js). Correr con:  node --test tests/
 *
 * La separación reasoning/respuesta la hace el BACKEND (canal
 * {"type":"reasoning"} + done.reasoning); este componente solo consume ese
 * canal y JAMÁS parsea los tokens de la respuesta. La ausencia de
 * reasoning en los logs del backend se cubre en el repo del runtime
 * (tests/test_reasoning_stream.py).
 */

const test = require("node:test");
const assert = require("node:assert");

const RB = require("../web/reasoning_block.js");

/* ── 1. Respuesta CON reasoning ─────────────────────────────────────── */

test("respuesta con reasoning: queda expandible al terminar", () => {
  const e = RB.crearEstado();
  RB.aplicarReasoning(e, "Voy a revisar el filesystem.\n");
  RB.aplicarReasoning(e, "Después compararé directorios.");
  RB.finalizar(e, "Voy a revisar el filesystem.\nDespués compararé directorios.");
  assert.strictEqual(e.isGenerating, false);
  assert.strictEqual(e.status, "Pensó");
  assert.strictEqual(e.reasoning, "Voy a revisar el filesystem.\nDespués compararé directorios.");
  assert.strictEqual(RB.tieneRazonamiento(e), true);
  assert.strictEqual(RB.debeDescartarBloque(e), false);
  // sigue expandible: el toggle funciona post-done
  assert.strictEqual(RB.toggleExpandido(e), true);
  assert.strictEqual(RB.toggleExpandido(e), false);
});

/* ── 2. Respuesta SIN reasoning ─────────────────────────────────────── */

test("respuesta sin reasoning: el bloque se descarta al terminar", () => {
  const e = RB.crearEstado();
  RB.aplicarStatus(e, "Ejecutando herramienta: shell...");
  RB.finalizar(e, "");
  assert.strictEqual(e.reasoning, "");
  assert.strictEqual(RB.tieneRazonamiento(e), false);
  assert.strictEqual(RB.debeDescartarBloque(e), true); // sin toggle inútil
});

test("sin reasoning ni done: mientras trabaja el bloque sigue vivo", () => {
  const e = RB.crearEstado();
  assert.strictEqual(e.isGenerating, true);
  assert.strictEqual(RB.debeDescartarBloque(e), false);
  assert.strictEqual(RB.tieneRazonamiento(e), false);
});

/* ── 3. Reasoning recibido por streaming ────────────────────────────── */

test("los fragmentos de streaming se acumulan en orden", () => {
  const e = RB.crearEstado();
  for (const frag of ["Voy ", "a revisar ", "primero ", "el filesystem."]) {
    RB.aplicarReasoning(e, frag);
  }
  assert.strictEqual(e.reasoning, "Voy a revisar primero el filesystem.");
});

test("fragmentos vacíos o no-string no alteran el acumulado", () => {
  const e = RB.crearEstado();
  RB.aplicarReasoning(e, "x");
  RB.aplicarReasoning(e, "");
  RB.aplicarReasoning(e, null);
  RB.aplicarReasoning(e, undefined);
  assert.strictEqual(e.reasoning, "x");
});

test("done.reasoning (autoritativo) gana si el cliente perdió fragmentos", () => {
  const e = RB.crearEstado();
  RB.aplicarReasoning(e, "solo vi la primera parte");
  RB.finalizar(e, "solo vi la primera parte pero el backend tiene TODO el razonamiento");
  assert.strictEqual(e.reasoning,
    "solo vi la primera parte pero el backend tiene TODO el razonamiento");
});

/* ── 4. Múltiples cambios de status ────────────────────────────────── */

test("estados específicos de herramienta se respetan tal cual", () => {
  const e = RB.crearEstado();
  RB.aplicarStatus(e, "[•] Ejecutando herramienta: shell");
  assert.strictEqual(e.status, "Ejecutando herramienta: shell...");
  RB.aplicarStatus(e, "[•] Consultando la web...");
  assert.strictEqual(e.status, "Consultando la web...");
  RB.aplicarStatus(e, "[•] Analizando pantalla...");
  assert.strictEqual(e.status, "Analizando pantalla...");
});

test("estados genéricos rotan verbos con personalidad (determinista)", () => {
  const e = RB.crearEstado();
  const vistos = [];
  for (let i = 0; i < 4; i++) {
    RB.aplicarStatus(e, "Analizando solicitud...");
    vistos.push(e.status);
  }
  // todos distintos entre sí y con "..." — el estado "vive"
  assert.strictEqual(new Set(vistos).size, 4);
  assert.ok(vistos.every((v) => v.endsWith("...")));
  // determinista: mismo update-count → mismo verbo en otra corrida
  const e2 = RB.crearEstado();
  let ultimo2 = "";
  for (let i = 0; i < 4; i++) {
    RB.aplicarStatus(e2, "Pensando");
    ultimo2 = e2.status;
  }
  assert.strictEqual(ultimo2, vistos[3]);
});

test("el prefijo de la TUI se limpia y '...' se asegura en vivo", () => {
  assert.strictEqual(RB.limpiarEstadoTUI("[•] Husmeando..."), "Husmeando...");
  assert.strictEqual(RB.estadoDisplay("Husmeando", 0, true), "Husmeando...");
  assert.strictEqual(RB.estadoDisplay("", 0, true), "Pensando...");
  assert.strictEqual(RB.estadoDisplay("Completado", 0, false), "Completado");
});

/* ── 5/6. Expansión / contracción, incluso terminado ────────────────── */

test("expandir y contraer togglea sin perder el contenido", () => {
  const e = RB.crearEstado();
  RB.aplicarReasoning(e, "razonamiento completo");
  assert.strictEqual(RB.toggleExpandido(e), true);
  assert.strictEqual(RB.toggleExpandido(e), false);
  assert.strictEqual(e.reasoning, "razonamiento completo"); // intacto
});

test("estado final Pensó no elimina el razonamiento recibido", () => {
  const e = RB.crearEstado();
  RB.aplicarReasoning(e, "importante");
  RB.finalizar(e, "");
  assert.strictEqual(e.status, "Pensó");
  assert.strictEqual(e.reasoning, "importante"); // finalizar sin done.reasoning NO borra
});

/* ── 7. Status sin reasoning: el estado funciona igual ──────────────── */

test("el status avanza aunque no llegue reasoning", () => {
  const e = RB.crearEstado();
  RB.aplicarStatus(e, "[•] Razonando qué herramienta usar...");
  const primero = e.status;
  RB.aplicarStatus(e, "[•] Ejecutando herramienta: web");
  assert.notStrictEqual(primero, e.status);
  assert.strictEqual(RB.tieneRazonamiento(e), false);
});

/* ── 8. Reasoning largo ─────────────────────────────────────────────── */

test("reasoning largo (10k chars) se guarda íntegro", () => {
  const e = RB.crearEstado();
  const chunk = "paso a paso del razonamiento ".repeat(20); // ~560 chars
  for (let i = 0; i < 18; i++) RB.aplicarReasoning(e, chunk);
  assert.strictEqual(e.reasoning.length, chunk.length * 18);
  assert.ok(e.reasoning.length > 10000);
  RB.finalizar(e, e.reasoning);
  assert.strictEqual(e.reasoning.length, chunk.length * 18);
});

/* ── 10. Separación reasoning ↔ respuesta final ─────────────────────── */

test("el flujo de reasoning nunca toca la respuesta (datos separados)", () => {
  // Simulación del contrato: answer_event va a SU buffer; reasoning_event
  // al estado del bloque. El componente no conoce la respuesta.
  const e = RB.crearEstado();
  let respuesta = "";
  respuesta += "La respuesta final del modelo.";           // answer_event
  RB.aplicarReasoning(e, "El razonamiento interno del modelo."); // reasoning_event
  RB.aplicarStatus(e, "Sintetizando");                     // status_event
  RB.finalizar(e, e.reasoning);

  assert.strictEqual(respuesta, "La respuesta final del modelo.");
  assert.ok(!respuesta.includes("razonamiento interno"));
  assert.ok(!e.reasoning.includes("respuesta final"));
  assert.strictEqual(e.status, "Pensó");
});

/* ── Error y verbos ─────────────────────────────────────────────────── */

test("error: el bloque se marca y sin reasoning se descarta", () => {
  const e = RB.crearEstado();
  RB.marcarError(e);
  assert.strictEqual(e.status, "Error");
  assert.strictEqual(e.isGenerating, false);
  assert.strictEqual(RB.debeDescartarBloque(e), true);
});

test("verbos disponibles y deterministas", () => {
  assert.ok(RB.VERBOS_TRABAJO.includes("Husmeando"));
  assert.ok(RB.VERBOS_TRABAJO.includes("Cocinando"));
  assert.strictEqual(RB.verboVariado(0), RB.verboVariado(10));
  assert.strictEqual(RB.verboVariado(3), "Inspeccionando");
});


/* ── F. Reasoning "vacío" (solo espacios) ──────────────────────────── */

test("reasoning con solo espacios NO cuenta como razonamiento (trim)", () => {
  const e = RB.crearEstado();
  RB.aplicarReasoning(e, "   ");
  RB.aplicarReasoning(e, "\n  ");
  assert.strictEqual(RB.tieneRazonamiento(e), false);
  RB.finalizar(e, "");
  assert.strictEqual(RB.debeDescartarBloque(e), true);
  assert.strictEqual(e.status, "Pensó");
});
