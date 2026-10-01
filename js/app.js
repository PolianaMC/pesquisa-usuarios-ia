/**
 * app.js — Motor de renderização, branching, randomização, validação e exportação.
 *
 * Modo atual: "public" — a resposta final é enviada por HTTPS ao Worker
 * (Cloudflare Worker + D1) definido em API_ENDPOINT. O modo "dev" (sem rede,
 * gravação apenas em localStorage, com ferramentas de teste) continua
 * disponível trocando APP_MODE — ver submitResponse() mais abaixo.
 */

const STORAGE_KEY = "pesquisa_ia_respostas_teste_v3";
const PENDING_STORAGE_KEY = "pesquisa_ia_respostas_pendentes_envio";

// Preenchimento em andamento, só nesta aba (sessionStorage): sobrevive a uma
// atualização acidental da página e ao botão/gesto "voltar", é apagado quando
// a aba é fechada e nunca sai do navegador. Não é cookie e não contém nada
// além das mesmas respostas que já estão em `state` (nenhum identificador).
const SESSION_STORAGE_KEY = "pesquisa_ia_sessao_em_andamento_v4";

// ---------- Configuração de ambiente ----------
// APP_MODE controla como submitResponse() entrega a resposta final:
//   "dev"    -> grava apenas em localStorage (comportamento atual, sem rede).
//   "public" -> envia via HTTPS POST para API_ENDPOINT e só confirma sucesso
//               após resposta do servidor.
// O modo é fixado no código-fonte, por decisão explícita de publicação — não
// há detecção automática de ambiente.
// Nenhuma chave, token ou credencial fica no frontend: o endpoint é apenas
// uma URL pública de recebimento, e a validação (CORS restrito à origem do
// GitHub Pages, lista de campos permitidos) fica no Worker, nunca aqui.
const APP_MODE = "public"; // "dev" | "public"
const API_ENDPOINT = "https://backend-questionario-teste.backend-questionario-teste.workers.dev"; // Worker de recebimento (POST /)

// Tudo o que é ferramenta de teste (modo depuração, exportação local, "(teste
// interno)" no título, textos de simulação) só existe quando IS_PUBLIC é false.
const IS_PUBLIC = APP_MODE === "public";

const state = {
  questionIndex: 0,  // índice em getAllQuestions() (V4: navegação pergunta a pergunta, não mais por bloco)
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
  // Se o participante escreveu algo em "Outra"/"Outro" na pergunta de origem,
  // a opção correspondente mostra esse texto (ex.: "Midjourney") em vez do
  // rótulo genérico. Só o rótulo exibido muda: o valor gravado continua sendo
  // "outra"/"outro", e o texto continua na variável *_outra/*_outro de origem.
  const typedOther = src.otherVariable ? (state.otherAnswers[src.otherVariable] || "").trim() : "";
  if (typedOther) opts = opts.map((o) => (o.hasOther ? Object.assign({}, o, { label: typedOther }) : o));
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

function currentQuestion() {
  return getAllQuestions()[state.questionIndex];
}

// Progresso calculado dinamicamente a partir do caminho real do participante
// (V4, granularidade de PERGUNTA): reutiliza a MESMA isVisible() já usada
// para renderizar — nenhuma lógica de branching duplicada aqui. Para índices
// já alcançados (<= questionIndex atual), conta só as perguntas com
// isVisible(q)===true nesse momento (reflete Q09->Q11, Q12->Q13,
// Q19->Q20-Q23 em tempo real). Para índices ainda não alcançados, usa 1 por
// pergunta como estimativa, já que o caminho futuro não é conhecido antes de
// o participante responder. Por construção current <= total sempre, current
// é sempre a posição REAL entre as perguntas efetivamente mostradas (nunca
// uma estimativa), e o percentual (current/total) é sempre não decrescente
// ao longo da navegação — nunca sugere uma posição incorreta.
// O consentimento (índice 0) não é uma pergunta: fica fora da contagem e tem
// rótulo próprio na barra; a contagem começa em Q01.
function getQuestionProgress() {
  const all = getAllQuestions();
  let current = 0;
  let total = 0;
  all.forEach((q, idx) => {
    if (idx === 0) return;
    if (idx <= state.questionIndex) {
      if (isVisible(q)) {
        current += 1;
        total += 1;
      }
    } else {
      total += 1;
    }
  });
  return { current, total };
}

function progressText() {
  if (state.questionIndex === 0) return "Etapa de consentimento";
  const { current, total } = getQuestionProgress();
  return `Pergunta ${current} de ${total}`;
}

// Avança/retrocede o cursor de navegação para a próxima/anterior pergunta
// VISÍVEL, pulando automaticamente condicionais ocultas (Q11, Q13 quando
// auto-preenchida, Q20-Q23) — usa a mesma isVisible(), sem duplicar nenhuma
// regra de branching. nextVisibleIndex retorna getAllQuestions().length
// quando não há mais nenhuma pergunta visível depois (fim do questionário).
function nextVisibleIndex(fromIndex) {
  const all = getAllQuestions();
  for (let i = fromIndex + 1; i < all.length; i++) {
    if (isVisible(all[i])) return i;
  }
  return all.length;
}

function prevVisibleIndex(fromIndex) {
  const all = getAllQuestions();
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (isVisible(all[i])) return i;
  }
  return 0;
}

function isLastScreen() {
  return nextVisibleIndex(state.questionIndex) >= getAllQuestions().length;
}

// Barra de progresso exposta a tecnologias assistivas (role="progressbar"),
// em vez de escondida com aria-hidden como na V4 original.
function renderProgress() {
  const isConsent = state.questionIndex === 0;
  const { current, total } = getQuestionProgress();
  const text = progressText();
  const wrap = el("div", { class: "progress-wrap" });
  const label = el("div", { class: "progress-label" }, text);
  const bar = el(
    "div",
    {
      class: "progress-bar",
      role: "progressbar",
      "aria-label": "Progresso do questionário",
      "aria-valuemin": "0",
      "aria-valuemax": String(total),
      "aria-valuenow": String(isConsent ? 0 : current),
      "aria-valuetext": text,
    },
    el("div", { class: "progress-fill", style: `width:${isConsent ? 0 : (current / total) * 100}%` })
  );
  wrap.append(label, bar);
  return wrap;
}

function isOtherSelected(q) {
  if (!q.otherVariable) return false;
  const otherValue = q.options.find((o) => o.hasOther).value;
  return q.type === "multi"
    ? (state.answers[q.variable] || []).includes(otherValue)
    : state.answers[q.variable] === otherValue;
}

function renderOtherField(q) {
  if (!q.otherVariable) return null;
  const currentVal = state.otherAnswers[q.otherVariable] || "";
  if (!isOtherSelected(q)) return null;
  const input = el("input", {
    type: "text",
    class: "field-other",
    "aria-label": "Especifique",
    placeholder: "Especifique (opcional)",
    value: currentVal,
    oninput: (e) => {
      state.otherAnswers[q.otherVariable] = e.target.value;
      saveSession();
    },
    onkeydown: advanceOnEnter,
  });
  return el("div", { class: "other-wrap" }, input);
}

// Enter em campo de texto de linha única avança (mesmo efeito do botão
// principal). Em <textarea> o Enter continua quebrando linha.
function advanceOnEnter(e) {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  handlePrimary();
}

// Cada <input> de opção guarda o valor real (número, booleano ou texto) para
// que a tela possa ser atualizada no lugar, sem ser recriada.
function optionInput(attrs, value) {
  const input = el("input", attrs);
  input._optionValue = value;
  return input;
}

function renderQuestion(q) {
  const wrap = el("fieldset", { class: "question", id: `wrap-${q.id}` });
  const legend = el("legend", { class: "question-text", id: `legend-${q.id}` }, q.text + (q.required === false ? "" : ""));
  wrap.appendChild(legend);
  if (q.hint) wrap.appendChild(el("p", { class: "hint", id: `hint-${q.id}` }, q.hint));

  if (q.type === "consent") {
    const label = el("label", { class: "consent-label" }, [
      el("input", {
        type: "checkbox",
        checked: state.answers[q.variable] === true,
        onchange: (e) => {
          state.answers[q.variable] = e.target.checked;
          onAnswerChanged(q);
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
      const radio = optionInput({
        type: "radio",
        name: q.id,
        id: inputId,
        checked: checked,
        onchange: () => {
          state.answers[q.variable] = o.value;
          if (q.id === "Q19") applyAutoFills();
          onAnswerChanged(q);
        },
      }, o.value);
      list.appendChild(el("label", { for: inputId, class: "option-label" }, [radio, el("span", {}, " " + o.label)]));
    });
    wrap.appendChild(list);
  } else if (q.type === "dynamic-single") {
    const opts = computeDynamicOptions(q);
    const list = el("div", { class: "options options-single" });
    opts.forEach((o) => {
      const inputId = `${q.id}-${String(o.value)}`;
      const checked = state.answers[q.variable] === o.value;
      const radio = optionInput({
        type: "radio",
        name: q.id,
        id: inputId,
        checked: checked,
        onchange: () => {
          state.answers[q.variable] = o.value;
          state.autoFilled[q.variable] = false; // escolha manual do participante, não mais preenchimento automático
          onAnswerChanged(q);
        },
      }, o.value);
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
      const checkbox = optionInput({
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
          onAnswerChanged(q);
        },
      }, o.value);
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
        onAnswerChanged(q);
      },
      onkeydown: advanceOnEnter,
    });
    wrap.appendChild(input);
  } else if (q.type === "textarea") {
    const textarea = el("textarea", {
      class: "field-textarea",
      rows: q.id === "Q25" ? "5" : "3",
      oninput: (e) => {
        state.answers[q.variable] = e.target.value;
        onAnswerChanged(q);
      },
    }, state.answers[q.variable] || "");
    wrap.appendChild(textarea);
  }

  const otherField = renderOtherField(q);
  if (otherField) wrap.appendChild(otherField);

  const err = state.errors[q.id];
  if (err) wrap.appendChild(el("p", { class: "error-text", id: `error-${q.id}`, role: "alert" }, err));
  updateDescribedBy(wrap, q);

  return wrap;
}

// Dica e mensagem de erro são associadas ao grupo (fieldset), para serem
// lidas junto com a pergunta por leitores de tela.
function updateDescribedBy(wrap, q) {
  const ids = [];
  if (wrap.querySelector(`#hint-${q.id}`)) ids.push(`hint-${q.id}`);
  if (wrap.querySelector(`#error-${q.id}`)) ids.push(`error-${q.id}`);
  if (ids.length) wrap.setAttribute("aria-describedby", ids.join(" "));
  else wrap.removeAttribute("aria-describedby");
}

// Tela única: índice 0 é a introdução+consentimento (bloco0 original,
// combinado — por instrução explícita, NÃO vira "uma pergunta por vez"),
// qualquer índice >= 1 mostra exatamente UMA pergunta de getAllQuestions().
// O título da tela (h1 no consentimento, legend da pergunta nas demais)
// recebe tabindex="-1" e data-screen-heading para receber o foco ao navegar.
function renderScreen() {
  appEl.innerHTML = "";
  applyAutoFills();

  appEl.appendChild(renderProgress());

  if (state.questionIndex === 0) {
    const block = BLOCKS[0];
    appEl.appendChild(el("h1", { class: "block-title", tabindex: "-1", "data-screen-heading": "" }, block.title));
    if (block.intro) {
      const introBox = el("div", { class: "intro-box" });
      block.intro.split("\n\n").forEach((p) => introBox.appendChild(el("p", {}, p)));
      appEl.appendChild(introBox);
    }
    appEl.appendChild(renderQuestion(block.questions[0]));
  } else {
    const q = currentQuestion();
    const node = renderQuestion(q);
    const legend = node.querySelector("legend");
    // Posição anunciada junto com a pergunta quando o foco chega ao título.
    legend.prepend(el("span", { class: "sr-only" }, progressText() + ": "));
    legend.setAttribute("tabindex", "-1");
    legend.setAttribute("data-screen-heading", "");
    appEl.appendChild(node);
  }

  appEl.appendChild(renderNav());
}

function renderNav() {
  const nav = el("div", { class: "nav-row" });
  if (state.questionIndex > 0) {
    nav.appendChild(el("button", { type: "button", class: "btn btn-secondary", onclick: handleBack }, "Voltar"));
  } else {
    nav.appendChild(el("span", {}));
  }
  const nextBtn = el(
    "button",
    { type: "button", id: "btn-next", class: "btn btn-primary", onclick: handlePrimary },
    isLastScreen() ? "Enviar respostas" : "Continuar"
  );
  nav.appendChild(nextBtn);
  return nav;
}

function focusScreenHeading() {
  const heading = appEl.querySelector("[data-screen-heading]");
  if (heading) heading.focus({ preventScroll: true });
}

// Atualiza a tela atual NO LUGAR depois de cada resposta, sem recriar o DOM.
// Na V4 original cada seleção recriava a tela inteira, o que destruía o foco
// do teclado (setas em rádio, Espaço em checkbox) e repetia a animação de
// entrada a cada clique.
function onAnswerChanged(q) {
  syncOptionInputs(q);
  syncOtherField(q);
  if (state.errors[q.id] && isAnswerValid(q)) clearError(q);
  updateNavButtons();
  saveSession();
}

// Reflete state.answers nos controles já existentes (necessário quando uma
// escolha desmarca outras, como a opção exclusiva de Q14).
function syncOptionInputs(q) {
  const wrap = document.getElementById(`wrap-${q.id}`);
  if (!wrap) return;
  const val = state.answers[q.variable];
  wrap.querySelectorAll("input[type=radio], input[type=checkbox]").forEach((input) => {
    if (!("_optionValue" in input)) return;
    const shouldCheck = q.type === "multi" ? Array.isArray(val) && val.includes(input._optionValue) : val === input._optionValue;
    if (input.checked !== shouldCheck) input.checked = shouldCheck;
  });
}

// Mostra/esconde o campo "Especifique" sem recriar a pergunta (o texto já
// digitado continua em state.otherAnswers e reaparece se a opção voltar).
function syncOtherField(q) {
  if (!q.otherVariable) return;
  const wrap = document.getElementById(`wrap-${q.id}`);
  if (!wrap) return;
  const existing = wrap.querySelector(".other-wrap");
  const shouldShow = isOtherSelected(q);
  if (shouldShow && !existing) {
    wrap.querySelector(".options").after(renderOtherField(q));
  } else if (!shouldShow && existing) {
    existing.remove();
  }
}

function updateNavButtons() {
  const btn = document.getElementById("btn-next");
  if (!btn) return;
  if (state.questionIndex === 0) {
    btn.disabled = !state.answers.consentimento;
  } else {
    btn.disabled = false;
  }
  const label = isLastScreen() ? "Enviar respostas" : "Continuar";
  if (btn.textContent !== label) btn.textContent = label;
}

// ---------- Validação ----------

// Mesmas regras de obrigatoriedade por tipo de pergunta que existiam em
// validateBlock() (V1-V3) — apenas extraídas para validar UMA pergunta por
// vez, consequência direta de navegar pergunta a pergunta. Nenhuma regra
// de validação foi alterada, só a granularidade da chamada.
// isAnswerValid() é a regra pura (sem efeitos); validateQuestion() a aplica e
// registra a mensagem de erro, como antes.
function isAnswerValid(q) {
  if (!isVisible(q)) return true;
  if (q.required === false) return true;

  const val = state.answers[q.variable];
  let ok = true;

  if (q.type === "consent") ok = val === true;
  else if (q.type === "multi") ok = Array.isArray(val) && val.length >= (q.minSelect || 1);
  else if (q.type === "boolean") ok = val === true || val === false;
  else if (q.type === "single" || q.type === "dynamic-single") ok = val !== undefined && val !== null && val !== "";
  else if (q.type === "text" || q.type === "textarea") ok = typeof val === "string" && val.trim().length > 0;

  return ok;
}

function validateQuestion(q) {
  state.errors = {};
  const ok = isAnswerValid(q);
  if (!ok) {
    state.errors[q.id] = "Este campo é obrigatório antes de avançar.";
  }
  return ok;
}

// Erro exibido/removido no lugar. O parágrafo é sempre recriado ao exibir,
// para que role="alert" seja anunciado de novo a cada tentativa de avançar.
function showError(q) {
  const wrap = document.getElementById(`wrap-${q.id}`);
  if (!wrap) return;
  const old = wrap.querySelector(".error-text");
  if (old) old.remove();
  wrap.appendChild(el("p", { class: "error-text", id: `error-${q.id}`, role: "alert" }, state.errors[q.id]));
  updateDescribedBy(wrap, q);
}

function clearError(q) {
  delete state.errors[q.id];
  const wrap = document.getElementById(`wrap-${q.id}`);
  if (!wrap) return;
  const p = wrap.querySelector(".error-text");
  if (p) p.remove();
  updateDescribedBy(wrap, q);
}

function focusFirstField(q) {
  const node = document.getElementById(`wrap-${q.id}`);
  if (!node) return;
  const focusable = node.querySelector("input, textarea");
  if (focusable) focusable.focus();
}

// ---------- Navegação ----------

// Botão principal: "Continuar" ou, na última tela visível, "Enviar respostas".
// A decisão é tomada no momento do clique (e não na renderização), porque a
// última tela pode mudar conforme as respostas condicionais.
function handlePrimary() {
  if (isLastScreen()) handleSubmit();
  else handleNext();
}

function handleNext() {
  const q = currentQuestion();
  const ok = validateQuestion(q);
  if (!ok) {
    showError(q);
    focusFirstField(q);
    return;
  }
  if (state.questionIndex === 0 && !state.tsStart) {
    state.tsStart = new Date();
  }
  const next = nextVisibleIndex(state.questionIndex);
  if (next >= getAllQuestions().length) {
    handleSubmit();
    return;
  }
  goToQuestion(next);
}

function handleBack() {
  goToQuestion(prevVisibleIndex(state.questionIndex));
}

// Troca de tela: salva o estado, rola para o topo e leva o foco ao título da
// nova pergunta (leitores de tela anunciam "Pergunta X de Y: <texto>").
function goToQuestion(index) {
  if (index > 0) armHistoryGuard();
  state.questionIndex = index;
  state.errors = {};
  saveSession();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  renderScreen();
  updateNavButtons();
  focusScreenHeading();
}

// ---------- Proteção contra perda de respostas ----------

function saveSession() {
  try {
    const data = state.submitted
      ? { v: 1, submitted: true } // após o envio, as respostas não ficam guardadas na sessão
      : {
          v: 1,
          questionIndex: state.questionIndex,
          answers: state.answers,
          otherAnswers: state.otherAnswers,
          randomOrders: state.randomOrders,
          autoFilled: state.autoFilled,
          tsStart: state.tsStart ? state.tsStart.toISOString() : null,
        };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // sessionStorage indisponível (ex.: navegação privada restrita): o
    // questionário continua funcionando, apenas sem essa proteção.
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (e) {
    // idem saveSession()
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Restaura o preenchimento salvo nesta aba. Retorna true se havia algo salvo.
// O índice restaurado é sempre uma tela válida: sem consentimento volta para
// o início; se a pergunta salva não estiver mais visível, recua para a
// anterior visível.
function restoreSession() {
  let data;
  try {
    data = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || "null");
  } catch (e) {
    return false;
  }
  if (!isPlainObject(data) || data.v !== 1) return false;
  if (data.submitted === true) {
    state.submitted = true;
    return true;
  }
  state.answers = isPlainObject(data.answers) ? data.answers : {};
  state.otherAnswers = isPlainObject(data.otherAnswers) ? data.otherAnswers : {};
  state.randomOrders = isPlainObject(data.randomOrders) ? data.randomOrders : {};
  state.autoFilled = isPlainObject(data.autoFilled) ? data.autoFilled : {};
  const ts = data.tsStart ? new Date(data.tsStart) : null;
  state.tsStart = ts && !isNaN(ts.getTime()) ? ts : null;

  const all = getAllQuestions();
  let idx = Number.isInteger(data.questionIndex) ? data.questionIndex : 0;
  if (idx < 0 || idx >= all.length || state.answers.consentimento !== true) idx = 0;
  else if (!isVisible(all[idx])) idx = prevVisibleIndex(idx);
  state.questionIndex = idx;
  return true;
}

// Botão/gesto "voltar" do navegador: dentro do questionário, leva à pergunta
// anterior em vez de sair da página. Para isso mantém-se UMA entrada extra no
// histórico (a "guarda"), criada no primeiro avanço — dentro de um clique ou
// tecla do participante, pois o Chrome ignora entradas criadas sem gesto do
// usuário. Na tela de consentimento (ou após o envio), "voltar" sai da página
// normalmente. Se a página for deixada mesmo assim, restoreSession() devolve
// o participante ao ponto em que estava ao retornar.
let historyGuardArmed = false;

function armHistoryGuard() {
  if (historyGuardArmed || state.submitted) return;
  try {
    history.pushState({ pesquisaGuard: true }, "");
    historyGuardArmed = true;
  } catch (e) {
    // sem History API: segue sem a guarda
  }
}

function initHistoryGuard() {
  historyGuardArmed = !!(history.state && history.state.pesquisaGuard);
  window.addEventListener("popstate", () => {
    historyGuardArmed = false;
    if (state.submitted || state.questionIndex === 0) {
      history.back();
      return;
    }
    goToQuestion(prevVisibleIndex(state.questionIndex));
  });
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
  const q = currentQuestion();
  const ok = validateQuestion(q);
  if (!ok) {
    showError(q);
    focusFirstField(q);
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
    saveSession();
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
  box.appendChild(el("h1", { tabindex: "-1", "data-screen-heading": "" }, "Não foi possível enviar sua resposta."));
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
            saveSession();
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
  focusScreenHeading();
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

// Tela final. Modo "public": só é exibida depois que o servidor confirmou o
// recebimento (submitResponsePublic resolveu), sem ferramentas de teste.
// Modo "dev": mantém o texto de simulação local e a exportação/limpeza.
function renderConfirmation() {
  appEl.innerHTML = "";
  const box = el("div", { class: "confirmation" });
  box.appendChild(el("h1", { tabindex: "-1", "data-screen-heading": "" }, "Obrigada por participar."));

  if (IS_PUBLIC) {
    box.appendChild(el("p", {}, "Suas respostas foram enviadas com sucesso."));
    box.appendChild(el("p", {}, "Você já pode fechar esta página."));
    appEl.appendChild(box);
    focusScreenHeading();
    return;
  }

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
        state.questionIndex = 0;
        state.answers = {};
        state.otherAnswers = {};
        state.randomOrders = {};
        state.tsStart = null;
        state.tsEnd = null;
        state.submitted = false;
        state.errors = {};
        state.autoFilled = {};
        clearSession();
        renderScreen();
        updateNavButtons();
        focusScreenHeading();
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
  focusScreenHeading();
}

// ---------- Ferramentas de teste (somente modo "dev") ----------

// A barra de depuração é criada aqui, e não no HTML, para que no modo
// "public" ela não exista na página em nenhum momento.
function initDevTools() {
  document.title = document.title + " (teste interno)";
  const toolbar = el("div", { class: "debug-toolbar" }, el("label", {}, [
    el("input", { type: "checkbox", id: "debug-toggle" }),
    " Modo depuração (mostra o estado interno das respostas — apenas nesta sessão, não é enviado a lugar nenhum)",
  ]));
  const panel = el("pre", { id: "debug-panel", hidden: true });
  appEl.before(toolbar, panel);
  initDebugPanel();
}

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
    { questionIndex: state.questionIndex, answers: state.answers, otherAnswers: state.otherAnswers },
    null,
    2
  );
}

// ---------- Inicialização ----------

document.addEventListener("DOMContentLoaded", () => {
  if (!IS_PUBLIC) initDevTools();
  initHistoryGuard();
  restoreSession();
  if (state.submitted) {
    renderConfirmation();
    return;
  }
  renderScreen();
  updateNavButtons();
});
