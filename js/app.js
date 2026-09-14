/**
 * app.js — Motor de renderização, branching, randomização, validação e exportação.
 *
 * Esta é uma implementação de TESTE INTERNO. Nesta etapa, APP_MODE permanece
 * fixo em "dev": nenhum dado sai do navegador, tudo é gravado em localStorage.
 * O código já está preparado para um futuro modo "public" (envio HTTPS para
 * um endpoint próprio), mas esse modo não está ativado — ver submitResponse()
 * mais abaixo e 08_IMPLEMENTACAO/ARQUITETURA_PUBLICA.md.
 */

const STORAGE_KEY = "pesquisa_ia_respostas_teste_v3";
const PENDING_STORAGE_KEY = "pesquisa_ia_respostas_pendentes_envio";

// ---------- Configuração de ambiente ----------
// APP_MODE controla como submitResponse() entrega a resposta final:
//   "dev"    -> grava apenas em localStorage (comportamento atual, sem rede).
//   "public" -> envia via HTTPS POST para API_ENDPOINT e só confirma sucesso
//               após resposta do servidor.
// Nesta etapa o modo permanece fixo em "dev" no código-fonte. A troca para
// "public" é uma decisão explícita de publicação (ver ARQUITETURA_PUBLICA.md
// e PLANO_DEPLOY_QUESTIONARIO.md), não uma detecção automática de ambiente.
// Nenhuma chave, token ou credencial fica no frontend: o endpoint é apenas
// uma URL pública de recebimento, e a validação/segredo (se houver) fica no
// Worker, nunca aqui.
const APP_MODE = "dev"; // "dev" | "public"
const API_ENDPOINT = ""; // URL do Worker; preenchida somente quando o backend existir

const state = {
  blockIndex: 0,
  answers: {},       // variable -> value | array | boolean | number | string
  otherAnswers: {},  // otherVariable -> string
  randomOrders: {},  // questionId -> array of shuffled option values (named options only)
  tsStart: null,
  tsEnd: null,
  submitted: false,
  errors: {},        // questionId -> mensagem de erro de validação exibida no bloco atual
  autoFilled: {},    // variable -> true quando o valor atual foi preenchido pelo sistema (autoFillIfSingle), não pelo participante
};

// ---------- Utilidades ----------

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getOrderedOptions(q) {
  if (!q.randomize) return q.options;
  if (!state.randomOrders[q.id]) {
    const named = q.options.filter((o) => !o.hasOther);
    const other = q.options.filter((o) => o.hasOther);
    state.randomOrders[q.id] = shuffle(named).map((o) => o.value).concat(other.map((o) => o.value));
  }
  const order = state.randomOrders[q.id];
  const byValue = Object.fromEntries(q.options.map((o) => [String(o.value), o]));
  return order.map((v) => byValue[String(v)]);
}

function findQuestion(id) {
  return getAllQuestions().find((q) => q.id === id);
}

function isVisible(q) {
  if (q.visibleIf) {
    const dep = q.visibleIf.question;
    const depQ = findQuestion(dep);
    const val = state.answers[depQ.variable];
    if (val !== q.visibleIf.equals) return false;
  }
  if (q.type === "dynamic-single") {
    const src = findQuestion(q.sourceQuestion);
    let selections = Array.isArray(state.answers[src.variable]) ? state.answers[src.variable] : [];
    if (q.excludeQuestion) {
      const excl = findQuestion(q.excludeQuestion);
      const exclVal = state.answers[excl.variable];
      selections = selections.filter((v) => v !== exclVal);
    }
    const minSel = q.minSourceSelections || 1;
    const baseSelections = Array.isArray(state.answers[src.variable]) ? state.answers[src.variable] : [];
    if (baseSelections.length < minSel) return false;
    if (q.autoFillIfSingle && baseSelections.length === 1) return false; // preenchida automaticamente, não exibida
  }
  return true;
}

function computeDynamicOptions(q) {
  const src = findQuestion(q.sourceQuestion);
  const srcSelections = Array.isArray(state.answers[src.variable]) ? state.answers[src.variable] : [];
  const orderedSrcOptions = getOrderedOptions(src);
  let opts = orderedSrcOptions.filter((o) => srcSelections.includes(o.value));
  if (q.excludeQuestion) {
    const excl = findQuestion(q.excludeQuestion);
    const exclVal = state.answers[excl.variable];
    opts = opts.filter((o) => o.value !== exclVal);
  }
  if (q.extraOption) opts = opts.concat([q.extraOption]);
  return opts;
}

// autoFill de Q13 quando Q12 tem exatamente 1 seleção
function applyAutoFills() {
  getAllQuestions().forEach((q) => {
    if (q.type === "dynamic-single" && q.autoFillIfSingle) {
      const src = findQuestion(q.sourceQuestion);
      const sel = Array.isArray(state.answers[src.variable]) ? state.answers[src.variable] : [];
      if (sel.length === 1) {
        state.answers[q.variable] = sel[0];
        state.autoFilled[q.variable] = true;
      } else if (state.autoFilled[q.variable]) {
        // o valor atual foi preenchido pelo sistema enquanto havia só 1 seleção
        // em Q12; agora que não há mais exatamente 1, esse valor não representa
        // uma escolha real do participante e não pode continuar marcado.
        delete state.answers[q.variable];
        state.autoFilled[q.variable] = false;
      } else if (state.answers[q.variable] !== undefined && !sel.includes(state.answers[q.variable])) {
        // escolha manual do participante que deixou de ser uma opção válida
        // (a atividade escolhida foi desmarcada em Q12)
        delete state.answers[q.variable];
      }
    }
  });
}

// ---------- Renderização ----------

const appEl = document.getElementById("app");

const BOOLEAN_DOM_PROPS = new Set(["checked", "disabled", "hidden", "selected", "required", "readOnly", "multiple", "autofocus"]);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (BOOLEAN_DOM_PROPS.has(k)) node[k] = v === true;
    else if (v === null || v === undefined) return;
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function renderProgress() {
  const totalBlocks = BLOCKS.length;
  const wrap = el("div", { class: "progress-wrap", "aria-hidden": "true" });
  const label = el("div", { class: "progress-label" }, `Bloco ${state.blockIndex + 1} de ${totalBlocks}`);
  const bar = el("div", { class: "progress-bar" }, el("div", { class: "progress-fill", style: `width:${((state.blockIndex) / (totalBlocks - 1)) * 100}%` }));
  wrap.append(label, bar);
  return wrap;
}

function renderOtherField(q) {
  if (!q.otherVariable) return null;
  const currentVal = state.otherAnswers[q.otherVariable] || "";
  const isOutroSelected =
    q.type === "multi"
      ? (state.answers[q.variable] || []).includes(q.options.find((o) => o.hasOther).value)
      : state.answers[q.variable] === q.options.find((o) => o.hasOther).value;
  if (!isOutroSelected) return null;
  const input = el("input", {
    type: "text",
    class: "field-other",
    "aria-label": "Especifique",
    placeholder: "Especifique (opcional)",
    value: currentVal,
    oninput: (e) => {
      state.otherAnswers[q.otherVariable] = e.target.value;
    },
  });
  return el("div", { class: "other-wrap" }, input);
}

function renderQuestion(q) {
  const wrap = el("fieldset", { class: "question", id: `wrap-${q.id}` });
  const legend = el("legend", { class: "question-text" }, q.text + (q.required === false ? "" : ""));
  wrap.appendChild(legend);
  if (q.hint) wrap.appendChild(el("p", { class: "hint" }, q.hint));

  if (q.type === "consent") {
    const label = el("label", { class: "consent-label" }, [
      el("input", {
        type: "checkbox",
        checked: state.answers[q.variable] === true,
        onchange: (e) => {
          state.answers[q.variable] = e.target.checked;
          updateNavButtons();
        },
      }),
      el("span", {}, " Sim, concordo em participar"),
    ]);
    wrap.appendChild(label);
  } else if (q.type === "single" || q.type === "boolean") {
    const opts = q.type === "boolean" ? [{ value: true, label: "Sim" }, { value: false, label: "Não" }] : getOrderedOptions(q);
    const list = el("div", { class: "options options-single" });
    opts.forEach((o) => {
      const inputId = `${q.id}-${String(o.value)}`;
      const checked = state.answers[q.variable] === o.value;
      const radio = el("input", {
        type: "radio",
        name: q.id,
        id: inputId,
        checked: checked,
        onchange: () => {
          state.answers[q.variable] = o.value;
          if (q.id === "Q19") applyAutoFills();
          rerender();
        },
      });
      list.appendChild(el("label", { for: inputId, class: "option-label" }, [radio, el("span", {}, " " + o.label)]));
    });
    wrap.appendChild(list);
  } else if (q.type === "dynamic-single") {
    const opts = computeDynamicOptions(q);
    const list = el("div", { class: "options options-single" });
    opts.forEach((o) => {
      const inputId = `${q.id}-${String(o.value)}`;
      const checked = state.answers[q.variable] === o.value;
      const radio = el("input", {
        type: "radio",
        name: q.id,
        id: inputId,
        checked: checked,
        onchange: () => {
          state.answers[q.variable] = o.value;
          state.autoFilled[q.variable] = false; // escolha manual do participante, não mais preenchimento automático
          rerender();
        },
      });
      list.appendChild(el("label", { for: inputId, class: "option-label" }, [radio, el("span", {}, " " + o.label)]));
    });
    if (opts.length === 0) wrap.appendChild(el("p", { class: "hint" }, "Nenhuma opção disponível (verifique a pergunta anterior)."));
    wrap.appendChild(list);
  } else if (q.type === "multi") {
    const opts = getOrderedOptions(q);
    const list = el("div", { class: "options options-multi" });
    const current = state.answers[q.variable] || [];
    opts.forEach((o) => {
      const inputId = `${q.id}-${String(o.value)}`;
      const checked = current.includes(o.value);
      const checkbox = el("input", {
        type: "checkbox",
        id: inputId,
        checked: checked,
        onchange: (e) => {
          let sel = state.answers[q.variable] ? state.answers[q.variable].slice() : [];
          if (e.target.checked) {
            if (q.exclusiveValue && o.value === q.exclusiveValue) {
              sel = [q.exclusiveValue];
            } else if (q.exclusiveValue) {
              sel = sel.filter((v) => v !== q.exclusiveValue);
              sel.push(o.value);
            } else {
              sel.push(o.value);
            }
          } else {
            sel = sel.filter((v) => v !== o.value);
          }
          state.answers[q.variable] = sel;
          if (q.id === "Q09" || q.id === "Q10") applyAutoFills();
          if (q.id === "Q12") applyAutoFills();
          rerender();
        },
      });
      list.appendChild(el("label", { for: inputId, class: "option-label" }, [checkbox, el("span", {}, " " + o.label)]));
    });
    wrap.appendChild(list);
  } else if (q.type === "text") {
    const input = el("input", {
      type: "text",
      class: "field-text",
      value: state.answers[q.variable] || "",
      oninput: (e) => {
        state.answers[q.variable] = e.target.value;
      },
    });
    wrap.appendChild(input);
  } else if (q.type === "textarea") {
    const textarea = el("textarea", {
      class: "field-textarea",
      rows: q.id === "Q25" ? "5" : "3",
      oninput: (e) => {
        state.answers[q.variable] = e.target.value;
      },
    }, state.answers[q.variable] || "");
    wrap.appendChild(textarea);
  }

  const otherField = renderOtherField(q);
  if (otherField) wrap.appendChild(otherField);

  const err = state.errors[q.id];
  if (err) wrap.appendChild(el("p", { class: "error-text", role: "alert" }, err));

  return wrap;
}

function renderBlock() {
  appEl.innerHTML = "";
  const block = BLOCKS[state.blockIndex];
  applyAutoFills();

  appEl.appendChild(renderProgress());

  const heading = el("h1", { class: "block-title" }, block.title);
  appEl.appendChild(heading);

  if (block.intro) {
    const introBox = el("div", { class: "intro-box" });
    block.intro.split("\n\n").forEach((p) => introBox.appendChild(el("p", {}, p)));
    appEl.appendChild(introBox);
  }

  block.questions.forEach((q) => {
    if (!isVisible(q)) return;
    appEl.appendChild(renderQuestion(q));
  });

  appEl.appendChild(renderNav());
}

function renderNav() {
  const nav = el("div", { class: "nav-row" });
  if (state.blockIndex > 0) {
    nav.appendChild(el("button", { type: "button", class: "btn btn-secondary", onclick: handleBack }, "Voltar"));
  } else {
    nav.appendChild(el("span", {}));
  }
  const isLast = state.blockIndex === BLOCKS.length - 1;
  const nextBtn = el(
    "button",
    { type: "button", id: "btn-next", class: "btn btn-primary", onclick: isLast ? handleSubmit : handleNext },
    isLast ? "Enviar respostas" : "Avançar"
  );
  nav.appendChild(nextBtn);
  return nav;
}

function rerender() {
  renderBlock();
  updateNavButtons();
}

function updateNavButtons() {
  const btn = document.getElementById("btn-next");
  if (!btn) return;
  if (state.blockIndex === 0) {
    btn.disabled = !state.answers.consentimento;
  } else {
    btn.disabled = false;
  }
}

// ---------- Validação ----------

function validateBlock() {
  const block = BLOCKS[state.blockIndex];
  state.errors = {};
  let firstInvalid = null;

  block.questions.forEach((q) => {
    if (!isVisible(q)) return;
    if (q.required === false) return;

    let val = state.answers[q.variable];
    let ok = true;

    if (q.type === "consent") ok = val === true;
    else if (q.type === "multi") ok = Array.isArray(val) && val.length >= (q.minSelect || 1);
    else if (q.type === "boolean") ok = val === true || val === false;
    else if (q.type === "single" || q.type === "dynamic-single") ok = val !== undefined && val !== null && val !== "";
    else if (q.type === "text" || q.type === "textarea") ok = typeof val === "string" && val.trim().length > 0;

    if (!ok) {
      state.errors[q.id] = "Este campo é obrigatório antes de avançar.";
      if (!firstInvalid) firstInvalid = q.id;
    }
  });

  return firstInvalid;
}

function handleNext() {
  const firstInvalid = validateBlock();
  if (firstInvalid) {
    renderBlock();
    const node = document.getElementById(`wrap-${firstInvalid}`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      const focusable = node.querySelector("input, textarea");
      if (focusable) focusable.focus();
    }
    return;
  }
  if (state.blockIndex === 0 && !state.tsStart) {
    state.tsStart = new Date();
  }
  state.blockIndex++;
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  renderBlock();
  updateNavButtons();
}

function handleBack() {
  state.blockIndex--;
  window.scrollTo({ top: 0 });
  renderBlock();
  updateNavButtons();
}

// ---------- Envio / exportação ----------

function buildResponseObject() {
  applyAutoFills();
  const resp = {};
  getAllQuestions().forEach((q) => {
    const isQVisible = isVisible(q) || (q.autoFillIfSingle && state.answers[q.variable] !== undefined);
    resp[q.variable] = isQVisible ? (state.answers[q.variable] !== undefined ? state.answers[q.variable] : null) : null;
    if (q.otherVariable) {
      const outroSelected = q.type === "multi"
        ? (state.answers[q.variable] || []).includes("outro") || (state.answers[q.variable] || []).includes("outra")
        : state.answers[q.variable] === "outro" || state.answers[q.variable] === "outra";
      resp[q.otherVariable] = outroSelected ? (state.otherAnswers[q.otherVariable] || "") : null;
    }
  });
  resp.consentimento = state.answers.consentimento === true;
  resp.timestamp_inicio = state.tsStart ? state.tsStart.toISOString() : null;
  resp.timestamp_fim = state.tsEnd ? state.tsEnd.toISOString() : null;
  resp.tempo_total_segundos =
    state.tsStart && state.tsEnd ? Math.round((state.tsEnd - state.tsStart) / 1000) : null;
  return resp;
}

function loadLocalResponses() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function saveResponseLocally(resp) {
  const all = loadLocalResponses();
  all.push(resp);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

// ---------- Envio (ponto único de troca DEV <-> publicação futura) ----------

/**
 * Ponto único de envio da resposta final. Isolado propositalmente: para
 * publicar o questionário no futuro, a única mudança necessária é trocar
 * APP_MODE para "public" e preencher API_ENDPOINT — nenhuma outra função
 * (validação, branching, randomização, construção do payload) muda.
 */
async function submitResponse(response) {
  if (APP_MODE === "public") return submitResponsePublic(response);
  return submitResponseLocal(response);
}

function submitResponseLocal(response) {
  saveResponseLocally(response);
  return Promise.resolve({ ok: true, mode: "dev" });
}

async function submitResponsePublic(response) {
  if (!API_ENDPOINT) {
    throw new Error("API_ENDPOINT não configurado. Defina o endpoint do Worker antes de ativar o modo 'public'.");
  }
  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    throw new Error(`Servidor recusou o envio (HTTP ${res.status}).`);
  }
  try {
    return await res.json();
  } catch (e) {
    return { ok: true };
  }
}

// Fila local de respostas que falharam ao tentar enviar no modo "public".
// Não é usada no modo "dev" (onde submitResponseLocal nunca rejeita) — existe
// para que, quando o modo "public" for ativado, uma falha de rede não perca a
// resposta do participante: ela fica salva localmente até um reenvio bem-sucedido.
function loadPendingResponses() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_STORAGE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function queuePendingResponse(resp) {
  const all = loadPendingResponses();
  all.push(resp);
  localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(all));
}

function clearPendingResponses() {
  localStorage.removeItem(PENDING_STORAGE_KEY);
}

async function retryPendingResponses() {
  const pending = loadPendingResponses();
  for (const item of pending) {
    await submitResponsePublic(item);
  }
  clearPendingResponses();
}

async function handleSubmit() {
  const firstInvalid = validateBlock();
  if (firstInvalid) {
    renderBlock();
    const node = document.getElementById(`wrap-${firstInvalid}`);
    if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  state.tsEnd = new Date();
  const resp = buildResponseObject();

  if (APP_MODE === "public") {
    const btn = document.getElementById("btn-next");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Enviando...";
    }
  }

  try {
    await submitResponse(resp);
    state.submitted = true;
    renderConfirmation();
  } catch (err) {
    queuePendingResponse(resp);
    renderSubmitError(err);
  }
}

// Tela exibida somente no modo "public", quando o envio ao servidor falha.
// A resposta já foi preservada localmente (queuePendingResponse) antes desta
// tela aparecer, então nada é perdido enquanto o participante tenta de novo.
function renderSubmitError(err) {
  appEl.innerHTML = "";
  const box = el("div", { class: "confirmation" });
  box.appendChild(el("h1", {}, "Não foi possível enviar sua resposta."));
  box.appendChild(el("p", {}, "Sua resposta foi salva neste dispositivo e será reenviada quando você tentar novamente. Verifique sua conexão com a internet."));
  box.appendChild(el("p", { class: "hint" }, String((err && err.message) || err || "")));

  const btnRow = el("div", { class: "nav-row" });
  btnRow.appendChild(
    el(
      "button",
      {
        type: "button",
        class: "btn btn-primary",
        onclick: async () => {
          try {
            await retryPendingResponses();
            state.submitted = true;
            renderConfirmation();
          } catch (err2) {
            renderSubmitError(err2);
          }
        },
      },
      "Tentar enviar novamente"
    )
  );
  box.appendChild(btnRow);
  appEl.appendChild(box);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join(";") : String(value);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(responses) {
  if (responses.length === 0) return "";
  const headers = Object.keys(responses[0]);
  const lines = [headers.join(",")];
  responses.forEach((r) => {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  });
  return lines.join("\n");
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderConfirmation() {
  appEl.innerHTML = "";
  const box = el("div", { class: "confirmation" });
  box.appendChild(el("h1", {}, "Obrigada por participar."));
  box.appendChild(el("p", {}, "Sua resposta foi registrada localmente, para fins de teste interno do instrumento. Nenhum dado foi enviado a nenhum servidor."));

  const all = loadLocalResponses();
  box.appendChild(el("p", { class: "hint" }, `${all.length} resposta(s) de teste armazenada(s) neste navegador.`));

  const btnRow = el("div", { class: "nav-row" });
  btnRow.appendChild(el("button", { type: "button", class: "btn btn-secondary", onclick: () => downloadFile("respostas_teste.json", JSON.stringify(all, null, 2), "application/json") }, "Baixar JSON"));
  btnRow.appendChild(el("button", { type: "button", class: "btn btn-secondary", onclick: () => downloadFile("respostas_teste.csv", toCSV(all), "text/csv") }, "Baixar CSV"));
  box.appendChild(btnRow);

  const restartRow = el("div", { class: "nav-row" });
  restartRow.appendChild(
    el("button", {
      type: "button",
      class: "btn btn-link",
      onclick: () => {
        state.blockIndex = 0;
        state.answers = {};
        state.otherAnswers = {};
        state.randomOrders = {};
        state.tsStart = null;
        state.tsEnd = null;
        state.submitted = false;
        state.autoFilled = {};
        renderBlock();
        updateNavButtons();
      },
    }, "Iniciar nova simulação de resposta")
  );
  restartRow.appendChild(
    el("button", {
      type: "button",
      class: "btn btn-link btn-danger",
      onclick: () => {
        localStorage.removeItem(STORAGE_KEY);
        renderConfirmation();
      },
    }, "Limpar todos os dados de teste deste navegador")
  );
  box.appendChild(restartRow);

  appEl.appendChild(box);
}

// ---------- Painel de depuração (somente local, não envia nada) ----------

function initDebugPanel() {
  const toggle = document.getElementById("debug-toggle");
  const panel = document.getElementById("debug-panel");
  if (!toggle || !panel) return;
  toggle.addEventListener("change", () => {
    panel.hidden = !toggle.checked;
    if (toggle.checked) refreshDebugPanel();
  });
  setInterval(() => {
    if (!panel.hidden) refreshDebugPanel();
  }, 800);
}

function refreshDebugPanel() {
  const panel = document.getElementById("debug-panel");
  if (!panel) return;
  panel.textContent = JSON.stringify(
    { blockIndex: state.blockIndex, answers: state.answers, otherAnswers: state.otherAnswers },
    null,
    2
  );
}

// ---------- Inicialização ----------

document.addEventListener("DOMContentLoaded", () => {
  renderBlock();
  updateNavButtons();
  initDebugPanel();
});
