import {
  categories,
  checkClaim,
  constraintStatus,
  defaultCard,
  money,
  normalizeCard,
  number,
  optimizeCard,
  parseBriefOffline,
  personas,
  simulate,
  simulatePortfolio,
} from "./economics.mjs";
import { detectProvider } from "./ai.mjs";

const MAX_SIMULATIONS = 5;

const state = {
  card: normalizeCard(defaultCard),
  selectedPersona: "professional",
  period: "ongoing",
  portfolio: [],
  optimization: null,
  ai: { provider: null, enabled: true, checking: true, reason: "" },
  chat: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function openPanel(panelId) {
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === panelId));
  $$(".step-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.target === panelId));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------------------
// Live AI plumbing
// ---------------------------------------------------------------------------

function liveMode() {
  return Boolean(state.ai.provider) && state.ai.enabled;
}

async function detectAI() {
  const { provider, reason } = await detectProvider();
  state.ai.provider = provider;
  state.ai.reason = reason || "";
  state.ai.checking = false;
  renderMode();
}

function renderMode() {
  const live = liveMode();
  const provider = state.ai.provider;
  const modelName = provider?.label || "Claude";
  $("#mode-badge").classList.toggle("offline", !live);
  $("#mode-label").textContent = state.ai.checking
    ? "Connecting to Claude…"
    : live
      ? `Live AI · ${modelName}`
      : provider
        ? "Offline mode (switched off)"
        : "Offline mode";
  $("#mode-badge").title = live ? "Claude is handling parsing, optimization, claims review, and chat." : state.ai.reason;
  $("#mode-switch").hidden = !provider;
  $("#live-toggle").checked = state.ai.enabled;
  $("#parse-badge").textContent = live ? "Claude · structured output" : "Offline parser";
  $("#brief-help").textContent = live
    ? `${modelName} turns the brief into structured, editable rules and explains each change.`
    : "Offline mode uses a repeatable parser so the demo never depends on a network call.";
  $("#optimize-note").textContent = live && provider.canOptimize
    ? `${modelName} proposes configurations and the deterministic simulator scores each one. Up to ${MAX_SIMULATIONS} simulations; you approve the result.`
    : `Offline optimizer: adjusts earn rates, annual fee, and benefit cost by fixed rules. Stops after ${MAX_SIMULATIONS} attempts.`;
  $("#chat-note").textContent = live
    ? "Answers are grounded in the current card, all persona results, and the latest optimization run."
    : "Live AI is required for chat. Offline mode keeps the rest of the workspace usable.";
}

async function withBusy(button, busyLabel, task) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function editableCard(card) {
  const { name, annualFee, welcomePoints, annualBenefitValue, annualBenefitCost, bonusRates } = card;
  return { name, annualFee, welcomePoints, annualBenefitValue, annualBenefitCost, bonusRates };
}

function fixedAssumptions(card) {
  return {
    interchangeRate: card.interchangeRate,
    breakageRate: card.breakageRate,
    issuerCostPerPoint: card.issuerCostPerPoint,
    customerValuePerPoint: card.customerValuePerPoint,
  };
}

function resultSummary(result, persona) {
  return {
    persona: persona.name,
    annualSpend: Math.round(result.annualSpend),
    pointsEarned: Math.round(result.pointsEarned),
    ongoingCustomerValue: Math.round(result.ongoingCustomerValue),
    yearOneCustomerValue: Math.round(result.yearOneCustomerValue),
    ongoingIssuerContribution: Math.round(result.ongoingContribution),
    yearOneIssuerContribution: Math.round(result.yearOneContribution),
    interchangeRevenue: Math.round(result.interchangeRevenue),
    rewardsCost: Math.round(result.ongoingRewardsCost),
    welcomeOfferCost: Math.round(result.welcomeOfferCost),
    costToSpendPercent: Number((result.costToSpendRatio * 100).toFixed(2)),
    personaValueThreshold: persona.valueThreshold,
  };
}

function portfolioSummary() {
  return simulatePortfolio(state.card).map((result) => resultSummary(result, personas[result.personaId]));
}

function describeChanges(before, after) {
  const changes = [];
  if (before.annualFee !== after.annualFee) changes.push(`fee ${money(before.annualFee)} → ${money(after.annualFee)}`);
  for (const category of categories) {
    if (before.bonusRates[category] !== after.bonusRates[category]) {
      changes.push(`${category} ${before.bonusRates[category]}x → ${after.bonusRates[category]}x`);
    }
  }
  if (before.welcomePoints !== after.welcomePoints) changes.push(`welcome ${number(before.welcomePoints)} → ${number(after.welcomePoints)} pts`);
  if (before.annualBenefitValue !== after.annualBenefitValue) changes.push(`benefit value ${money(before.annualBenefitValue)} → ${money(after.annualBenefitValue)}`);
  if (before.annualBenefitCost !== after.annualBenefitCost) changes.push(`benefit cost ${money(before.annualBenefitCost)} → ${money(after.annualBenefitCost)}`);
  return changes;
}

// ---------------------------------------------------------------------------
// Design panel
// ---------------------------------------------------------------------------

function renderRateFields() {
  const container = $("#category-rate-fields");
  container.innerHTML = categories
    .map(
      (category) => `
        <div class="category-field">
          <label>
            <span>${escapeHtml(category)}</span>
            <input data-rate-category="${category}" type="number" min="0.5" max="10" step="0.5" value="${state.card.bonusRates[category]}" />
            <em>x</em>
          </label>
        </div>`,
    )
    .join("");
}

function populateForm() {
  $("#card-name").value = state.card.name;
  $("#annual-fee").value = state.card.annualFee;
  $("#welcome-points").value = state.card.welcomePoints;
  $("#benefit-value").value = state.card.annualBenefitValue;
  $("#benefit-cost").value = state.card.annualBenefitCost;
  $("#interchange-rate").value = (state.card.interchangeRate * 100).toFixed(2);
  $("#breakage-rate").value = (state.card.breakageRate * 100).toFixed(0);
  $("#issuer-point-cost").value = (state.card.issuerCostPerPoint * 100).toFixed(2);
  $("#customer-point-value").value = (state.card.customerValuePerPoint * 100).toFixed(2);
  renderRateFields();
}

function readForm() {
  const bonusRates = {};
  $$("[data-rate-category]").forEach((input) => {
    bonusRates[input.dataset.rateCategory] = Number(input.value);
  });
  state.card = normalizeCard({
    ...state.card,
    name: $("#card-name").value,
    annualFee: Number($("#annual-fee").value),
    welcomePoints: Number($("#welcome-points").value),
    annualBenefitValue: Number($("#benefit-value").value),
    annualBenefitCost: Number($("#benefit-cost").value),
    interchangeRate: Number($("#interchange-rate").value) / 100,
    breakageRate: Number($("#breakage-rate").value) / 100,
    issuerCostPerPoint: Number($("#issuer-point-cost").value) / 100,
    customerValuePerPoint: Number($("#customer-point-value").value) / 100,
    bonusRates,
  });
  refreshAll();
}

function renderParseSummary(parsed) {
  const summary = $("#parse-summary");
  if (parsed.mode === "live") {
    const list = (items) => `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
    const rationale = parsed.rationale.length
      ? list(parsed.rationale.map((item) => `<strong>${escapeHtml(item.field)}</strong> ${escapeHtml(item.change)}: <span class="muted">${escapeHtml(item.why)}</span>`))
      : "<p>No changes were needed.</p>";
    summary.innerHTML = `
      <span class="ai-tag">Claude</span> ${rationale}
      ${parsed.assumptions.length ? `<p class="muted"><strong>Assumptions</strong></p>${list(parsed.assumptions.map(escapeHtml))}` : ""}
      ${parsed.unsupported.length ? `<p class="muted"><strong>Not modeled</strong></p>${list(parsed.unsupported.map(escapeHtml))}` : ""}`;
  } else {
    summary.innerHTML = `<span class="ai-tag rule">Offline parser</span> ${escapeHtml(parsed.changes.join(" · "))}${parsed.note ? `<p class="muted">${escapeHtml(parsed.note)}</p>` : ""}`;
  }
  summary.classList.remove("hidden");
}

async function createCardRules(brief) {
  const before = state.card;
  let parsed;
  if (liveMode()) {
    try {
      const data = await state.ai.provider.parse(brief, editableCard(state.card));
      parsed = { mode: "live", card: { ...state.card, ...data.card }, rationale: data.rationale, assumptions: data.assumptions, unsupported: data.unsupported };
    } catch (error) {
      parsed = { ...parseBriefOffline(brief, state.card), mode: "offline", note: `Live AI unavailable (${error.message}); used the offline parser.` };
    }
  } else {
    parsed = { ...parseBriefOffline(brief, state.card), mode: "offline" };
  }
  state.card = normalizeCard(parsed.card);
  populateForm();
  refreshAll();
  renderParseSummary(parsed);
  return { card: state.card, mode: parsed.mode, changes: describeChanges(before, state.card) };
}

function topCategories(card) {
  return Object.entries(card.bonusRates)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
}

function renderPreview() {
  const top = topCategories(state.card);
  $("#preview-name").textContent = state.card.name;
  $("#preview-summary").textContent = `${top[0][1]}x ${top[0][0]} · ${top[1][1]}x ${top[1][0]} · ${money(state.card.annualFee)} annual fee`;
  $("#preview-welcome").textContent = `${number(state.card.welcomePoints)} pts`;
  $("#preview-top-rate").textContent = `${top[0][1]}x`;
  $("#preview-fee").textContent = money(state.card.annualFee);
  $("#assumption-interchange").textContent = `${(state.card.interchangeRate * 100).toFixed(2)}%`;
  $("#assumption-breakage").textContent = `${(state.card.breakageRate * 100).toFixed(0)}%`;
  $("#assumption-cost").textContent = `${(state.card.issuerCostPerPoint * 100).toFixed(2)}¢`;
  $("#assumption-value").textContent = `${(state.card.customerValuePerPoint * 100).toFixed(2)}¢`;
}

// ---------------------------------------------------------------------------
// Simulation panel
// ---------------------------------------------------------------------------

function renderPersonas() {
  const list = $("#persona-list");
  list.innerHTML = Object.values(personas)
    .map(
      (persona, index) => `
        <button class="persona-button ${persona.id === state.selectedPersona ? "active" : ""}" data-persona="${persona.id}" type="button">
          <span class="persona-icon">${index + 1}</span>
          <span><strong>${escapeHtml(persona.name)}</strong><small>${escapeHtml(persona.description)}</small></span>
        </button>`,
    )
    .join("");
  $$("[data-persona]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPersona = button.dataset.persona;
      renderPersonas();
      renderResults();
    });
  });
}

function barRow(label, value, max, kind = "") {
  const width = max ? Math.min(100, Math.abs(value) / max * 100) : 0;
  return `<div class="bridge-row"><span>${escapeHtml(label)}</span><div class="bridge-track"><div class="bridge-fill ${kind} ${value < 0 ? "negative" : ""}" style="width:${width}%"></div></div><strong>${money(value)}</strong></div>`;
}

function renderResults() {
  state.portfolio = simulatePortfolio(state.card);
  const persona = personas[state.selectedPersona];
  const result = simulate(state.card, persona);
  const yearOne = state.period === "yearOne";
  const customerValue = yearOne ? result.yearOneCustomerValue : result.ongoingCustomerValue;
  const contribution = yearOne ? result.yearOneContribution : result.ongoingContribution;

  $("#results-title").textContent = `${persona.name} results`;
  $("#kpi-customer").textContent = money(customerValue);
  $("#kpi-contribution").textContent = money(contribution);
  $("#kpi-points").textContent = number(result.pointsEarned);
  $("#kpi-cost-ratio").textContent = `${(result.costToSpendRatio * 100).toFixed(2)}%`;
  $("#kpi-customer-note").textContent = yearOne ? "Includes welcome offer" : "After annual fee";
  $("#kpi-customer").parentElement.className = `kpi ${customerValue >= 0 ? "positive" : "negative"}`;
  $("#kpi-contribution").parentElement.className = `kpi ${contribution >= 0 ? "positive" : "negative"}`;

  const components = [
    ["Interchange", result.interchangeRevenue, ""],
    ["Annual fee", state.card.annualFee, ""],
    ["Rewards cost", -result.ongoingRewardsCost, "cost"],
    ["Benefits cost", -state.card.annualBenefitCost, "cost"],
  ];
  if (yearOne) components.push(["Welcome cost", -result.welcomeOfferCost, "cost"]);
  const max = Math.max(...components.map(([, value]) => Math.abs(value)));
  $("#value-bridge").innerHTML = components.map(([label, value, kind]) => barRow(label, value, max, kind)).join("");

  $("#portfolio-table").innerHTML = state.portfolio
    .map((item) => {
      const itemPersona = personas[item.personaId];
      const itemCustomer = yearOne ? item.yearOneCustomerValue : item.ongoingCustomerValue;
      const itemContribution = yearOne ? item.yearOneContribution : item.ongoingContribution;
      return `<tr>
        <td><strong>${escapeHtml(itemPersona.name)}</strong><span class="status-pill ${itemCustomer >= itemPersona.valueThreshold ? "pass" : "watch"}">${itemCustomer >= itemPersona.valueThreshold ? "Value clears threshold" : "Review value"}</span></td>
        <td>${money(item.annualSpend)}</td>
        <td>${money(itemCustomer)}</td>
        <td>${money(itemContribution)}</td>
        <td>${(item.costToSpendRatio * 100).toFixed(2)}%</td>
      </tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Optimization panel
// ---------------------------------------------------------------------------

function renderObjectivePersonas() {
  $("#objective-persona").innerHTML = Object.values(personas)
    .map((persona) => `<option value="${persona.id}">${escapeHtml(persona.name)}</option>`)
    .join("");
  $("#objective-persona").value = "family";
}

function readObjective() {
  return {
    minimumCustomerValue: Number($("#objective-value").value),
    maximumCostRatio: Number($("#objective-cost").value) / 100,
    minimumContribution: Number($("#objective-contribution").value),
  };
}

function bestAttempt(attempts) {
  const score = (attempt) => attempt.status.customerGap / 100 + attempt.status.costGap * 100 + attempt.status.contributionGap / 100;
  return attempts.find((attempt) => attempt.status.met) || [...attempts].sort((a, b) => score(a) - score(b))[0];
}

async function runAgentOptimization(persona, objective, onProgress) {
  const startCard = state.card;
  const context = {
    card: editableCard(startCard),
    persona: { id: persona.id, name: persona.name, description: persona.description, annualSpendByCategory: persona.spending, benefitUtilization: persona.benefitUtilization },
    objective: {
      minimumOngoingCustomerValue: objective.minimumCustomerValue,
      maximumCostToSpendPercent: Number((objective.maximumCostRatio * 100).toFixed(2)),
      minimumOngoingIssuerContribution: objective.minimumContribution,
    },
    fixedAssumptions: fixedAssumptions(startCard),
  };
  const attempts = [];
  let recommendation = null;

  // Claude proposes through these tools; the deterministic simulator answers.
  const handlers = {
    simulate_card(input) {
      if (attempts.length >= MAX_SIMULATIONS) throw new Error("Simulation budget is used up. Call submit_recommendation with the best attempt so far.");
      const { hypothesis, ...changes } = input || {};
      const previous = attempts.at(-1)?.card || startCard;
      const card = normalizeCard({ ...startCard, ...changes, bonusRates: { ...startCard.bonusRates, ...changes.bonusRates }, name: startCard.name });
      const result = simulate(card, persona);
      const status = constraintStatus(result, objective);
      const attempt = { number: attempts.length + 1, card, result, status, explanation: String(hypothesis || "Tested a revised configuration."), changes: describeChanges(previous, card), source: "ai" };
      attempts.push(attempt);
      onProgress(attempts);
      return {
        attemptNumber: attempt.number,
        ...resultSummary(result, persona),
        gaps: {
          customerValueShortfall: Math.round(status.customerGap),
          costToSpendOverLimitPercent: Number((status.costGap * 100).toFixed(2)),
          contributionShortfall: Math.round(status.contributionGap),
        },
        allObjectivesMet: status.met,
        simulationsRemaining: MAX_SIMULATIONS - attempts.length,
      };
    },
    submit_recommendation(input) {
      recommendation = {
        attemptNumber: Number(input?.attemptNumber),
        headline: String(input?.headline || "Recommended configuration"),
        summary: String(input?.summary || ""),
        tradeoffs: Array.isArray(input?.tradeoffs) ? input.tradeoffs.map(String) : [],
        nextValidation: String(input?.nextValidation || ""),
      };
      return "Recommendation delivered to the product manager.";
    },
  };

  let stopReason = "";
  try {
    await state.ai.provider.optimize(context, handlers);
  } catch (error) {
    if (!attempts.length) throw error;
    stopReason = `The agent stopped early (${error.message}).`;
  }
  if (!attempts.length) throw new Error("The agent did not run any simulations");
  if (!recommendation && !stopReason) stopReason = "The agent finished without submitting a recommendation.";
  const chosen = attempts.find((attempt) => attempt.number === recommendation?.attemptNumber) || bestAttempt(attempts);
  return { mode: "live", personaId: persona.id, objective, attempts, recommended: chosen, recommendation, stopReason };
}

async function runOptimization() {
  readForm();
  const persona = personas[$("#objective-persona").value];
  const objective = readObjective();
  if (liveMode() && state.ai.provider.canOptimize) {
    $("#attempts-empty").classList.add("hidden");
    $("#recommendation-card").classList.add("hidden");
    $("#agent-status").textContent = "Agent working";
    const list = $("#attempts-list");
    list.classList.remove("hidden");
    list.innerHTML = '<div class="thinking">Claude is studying the persona and forming a first hypothesis…</div>';
    const progress = (attempts) => {
      list.innerHTML = attempts.map(renderAttempt).join("") + '<div class="thinking">Claude is reading the simulator output…</div>';
    };
    try {
      state.optimization = await runAgentOptimization(persona, objective, progress);
    } catch (error) {
      showToast(`Live agent unavailable (${error.message}); ran the offline optimizer.`);
      state.optimization = { ...optimizeCard(state.card, persona, objective, MAX_SIMULATIONS), mode: "offline" };
    }
  } else {
    state.optimization = { ...optimizeCard(state.card, persona, objective, MAX_SIMULATIONS), mode: "offline" };
  }
  renderOptimization();
  return state.optimization;
}

function renderAttempt(attempt) {
  const label = attempt.source === "ai" ? '<b>Claude:</b> ' : "";
  return `<div class="attempt ${attempt.status.met ? "success" : ""}">
      <div class="attempt-top">
        <div class="attempt-title"><span class="attempt-number">${attempt.number}</span><strong>Attempt ${attempt.number}</strong></div>
        <span class="attempt-state">${attempt.status.met ? "All constraints met" : "Revising"}</span>
      </div>
      <p class="hypothesis">${label}${escapeHtml(attempt.explanation)}</p>
      ${attempt.changes?.length ? `<p class="attempt-changes">Changed: ${escapeHtml(attempt.changes.join(" · "))}</p>` : ""}
      <div class="attempt-metrics">
        <div><span>Annual fee</span><strong>${money(attempt.card.annualFee)}</strong></div>
        <div><span>Customer value</span><strong>${money(attempt.result.ongoingCustomerValue)}</strong></div>
        <div><span>Cost / spend</span><strong>${(attempt.result.costToSpendRatio * 100).toFixed(2)}%</strong></div>
        <div><span>Contribution</span><strong>${money(attempt.result.ongoingContribution)}</strong></div>
      </div>
    </div>`;
}

function renderOptimization() {
  const output = state.optimization;
  if (!output) return;
  $("#attempts-empty").classList.add("hidden");
  $("#attempts-list").classList.remove("hidden");
  $("#recommendation-card").classList.remove("hidden");
  const final = output.recommended;
  $("#agent-status").textContent = `${output.mode === "live" ? "Claude agent" : "Offline rules"} · ${final.status.met ? "Objectives met" : "Review required"}`;
  $("#attempts-list").innerHTML = output.attempts.map(renderAttempt).join("");

  const rec = output.recommendation;
  $("#recommendation-title").textContent = rec?.headline || (final.status.met ? "Constraints satisfied" : "Best bounded attempt");
  $("#recommendation-copy").textContent = rec
    ? `Attempt ${final.number} of ${output.attempts.length}${final.status.met ? "" : " (the simulator shows not every objective is met)"}. ${rec.summary}`
    : `${output.attempts.length} configuration${output.attempts.length === 1 ? " was" : "s were"} tested; attempt ${final.number} is recommended. ${output.stopReason || ""} Review the assumptions before applying this design.`;
  $("#recommendation-detail").className = "recommendation-detail";
  $("#recommendation-detail").innerHTML = rec
    ? `${rec.tradeoffs.length ? `<h3>Trade-offs</h3><ul>${rec.tradeoffs.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
       <h3>Validate next</h3><p>${escapeHtml(rec.nextValidation)}</p>`
    : "";
}

// ---------------------------------------------------------------------------
// Claims panel
// ---------------------------------------------------------------------------

function findingHtml(finding, source) {
  return `<div class="finding ${finding.severity}"><span class="finding-dot"></span><div>
    <div class="finding-head"><strong>${escapeHtml(finding.title)}</strong><span class="ai-tag ${source === "rule" ? "rule" : ""}">${source === "rule" ? "Rule check" : "Claude"}</span></div>
    <p>${escapeHtml(finding.detail)}</p>
    ${finding.evidence ? `<p class="evidence">Evidence: ${escapeHtml(finding.evidence)}</p>` : ""}
  </div></div>`;
}

async function runClaimsCheck() {
  readForm();
  const claim = $("#claim-input").value;
  const ruleFindings = checkClaim(claim, state.card, state.portfolio);
  const rewriteBox = $("#claim-rewrite");
  rewriteBox.classList.add("hidden");
  if (!liveMode()) {
    $("#claim-results").innerHTML = ruleFindings.map((finding) => findingHtml(finding, "rule")).join("");
    return { mode: "offline", findings: ruleFindings };
  }
  $("#claim-results").innerHTML = '<div class="thinking">Claude is comparing the claim with the card terms and every persona result…</div>';
  try {
    const data = await state.ai.provider.claims({
      claim,
      card: editableCard(state.card),
      portfolio: portfolioSummary(),
      ruleFindings: ruleFindings.filter((finding) => finding.severity !== "pass"),
    });
    const findings = data.findings.length
      ? data.findings.map((finding) => findingHtml(finding, "ai")).join("")
      : findingHtml({ severity: "pass", title: "No inconsistencies found", detail: "The claim still requires human legal and compliance review." }, "ai");
    $("#claim-results").innerHTML = findings;
    $("#claim-rewrite-text").textContent = data.suggestedRewrite;
    rewriteBox.classList.toggle("hidden", !data.suggestedRewrite);
    return { mode: "live", ...data };
  } catch (error) {
    showToast(`Live review unavailable (${error.message}); showing rule checks.`);
    $("#claim-results").innerHTML = ruleFindings.map((finding) => findingHtml(finding, "rule")).join("");
    return { mode: "offline", findings: ruleFindings };
  }
}

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

function workspaceSnapshot() {
  const optimization = state.optimization;
  return {
    card: editableCard(state.card),
    fixedAssumptions: fixedAssumptions(state.card),
    personas: Object.values(personas).map((persona) => ({ id: persona.id, name: persona.name, description: persona.description, annualSpendByCategory: persona.spending, benefitUtilization: persona.benefitUtilization })),
    results: portfolioSummary(),
    selectedPersona: personas[state.selectedPersona].name,
    latestOptimization: optimization
      ? {
          mode: optimization.mode,
          persona: personas[optimization.personaId].name,
          attemptsTested: optimization.attempts.length,
          recommendedAttempt: optimization.recommended.number,
          objectivesMet: optimization.recommended.status.met,
          headline: optimization.recommendation?.headline || null,
        }
      : null,
  };
}

function renderChat(pending = false) {
  const log = $("#chat-log");
  $("#chat-empty").classList.toggle("hidden", state.chat.length > 0 || pending);
  log.querySelectorAll(".bubble, .thinking").forEach((node) => node.remove());
  for (const turn of state.chat) {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${turn.error ? "error" : turn.role}`;
    bubble.textContent = turn.text;
    log.append(bubble);
  }
  if (pending) log.insertAdjacentHTML("beforeend", '<div class="thinking">Claude is reviewing the workspace…</div>');
  log.scrollTop = log.scrollHeight;
}

async function askAnalyst(question) {
  readForm();
  const trimmed = question.trim();
  if (!trimmed) return null;
  if (!liveMode()) {
    state.chat.push({ role: "user", text: trimmed }, { role: "assistant", text: state.ai.provider ? "Chat needs live AI. Switch Live AI back on in the header." : "Chat needs live AI. Open this page inside Claude, or run the app with an Anthropic API key.", error: true });
    renderChat();
    return null;
  }
  const history = state.chat.filter((turn) => !turn.error).slice(-20).map(({ role, text }) => ({ role, text }));
  state.chat.push({ role: "user", text: trimmed });
  renderChat(true);
  try {
    const answer = await state.ai.provider.chat(trimmed, history, workspaceSnapshot());
    state.chat.push({ role: "assistant", text: answer });
    renderChat();
    return answer;
  } catch (error) {
    state.chat.pop();
    state.chat.push({ role: "user", text: trimmed }, { role: "assistant", text: `Could not answer: ${error.message}`, error: true });
    renderChat();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function refreshAll() {
  renderPreview();
  renderPersonas();
  renderResults();
}

function resetScenario() {
  state.card = normalizeCard(defaultCard);
  state.selectedPersona = "professional";
  state.period = "ongoing";
  state.optimization = null;
  state.chat = [];
  populateForm();
  refreshAll();
  renderChat();
  $("#attempts-empty").classList.remove("hidden");
  $("#attempts-list").classList.add("hidden");
  $("#recommendation-card").classList.add("hidden");
  $("#parse-summary").classList.add("hidden");
  $("#claim-rewrite").classList.add("hidden");
  $("#agent-status").textContent = "Ready";
  openPanel("design-panel");
  showToast("Scenario reset");
}

function wireEvents() {
  $$(".step-tab").forEach((tab) => tab.addEventListener("click", () => openPanel(tab.dataset.target)));
  $("#live-toggle").addEventListener("change", (event) => {
    state.ai.enabled = event.target.checked;
    renderMode();
    showToast(state.ai.enabled ? "Live AI on" : "Offline mode on: deterministic parser and optimizer");
  });
  $("#parse-button").addEventListener("click", (event) =>
    withBusy(event.currentTarget, liveMode() ? "Claude is reading…" : "Parsing…", async () => {
      const result = await createCardRules($("#brief-input").value);
      showToast(result.mode === "live" ? "Claude created editable card rules" : "Editable card rules created");
    }),
  );
  $("#apply-rules-button").addEventListener("click", () => {
    readForm();
    showToast("Card rules updated");
  });
  $("#reset-button").addEventListener("click", resetScenario);
  $$("[data-period]").forEach((button) => button.addEventListener("click", () => {
    state.period = button.dataset.period;
    $$("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
    renderResults();
  }));
  $("#optimize-button").addEventListener("click", (event) =>
    withBusy(event.currentTarget, liveMode() && state.ai.provider.canOptimize ? "Agent running…" : "Running…", async () => {
      const output = await runOptimization();
      showToast(output.mode === "live" ? `Claude tested ${output.attempts.length} configurations` : "Optimization loop completed");
    }),
  );
  $("#accept-recommendation").addEventListener("click", () => {
    if (!state.optimization) return;
    state.card = normalizeCard({ ...state.optimization.recommended.card, name: state.card.name });
    populateForm();
    refreshAll();
    showToast("Recommendation applied for human review");
    openPanel("simulation-panel");
  });
  $("#check-claim-button").addEventListener("click", (event) =>
    withBusy(event.currentTarget, liveMode() ? "Claude is reviewing…" : "Checking…", async () => {
      await runClaimsCheck();
      showToast("Claim checked against the current model");
    }),
  );
  $("#use-rewrite-button").addEventListener("click", () => {
    $("#claim-input").value = $("#claim-rewrite-text").textContent;
    $("#check-claim-button").click();
  });
  $("#chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chat-input");
    const question = input.value;
    input.value = "";
    withBusy($("#chat-send"), "…", () => askAnalyst(question));
  });
  $$("#chat-suggestions .suggestion").forEach((button) => button.addEventListener("click", () => {
    if ($("#chat-send").disabled) return;
    withBusy($("#chat-send"), "…", () => askAnalyst(button.textContent));
  }));
  $("#clear-chat-button").addEventListener("click", () => {
    state.chat = [];
    renderChat();
  });
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => {
    try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch { /* unsupported host */ }
  };

  register({
    name: "create_card_rules",
    title: "Create editable card rules",
    description: "Convert a plain-language rewards-card brief into editable structured rules in the visible RewardsLab workspace.",
    inputSchema: { type: "object", properties: { brief: { type: "string", minLength: 10 } }, required: ["brief"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      if (!input || typeof input.brief !== "string" || input.brief.trim().length < 10) throw new Error("Brief must contain at least 10 characters");
      $("#brief-input").value = input.brief;
      openPanel("design-panel");
      return createCardRules(input.brief);
    },
  });

  register({
    name: "run_card_simulation",
    title: "Run card simulation",
    description: "Run the current card configuration against one synthetic customer persona and show the results.",
    inputSchema: { type: "object", properties: { personaId: { type: "string", enum: Object.keys(personas) } }, required: ["personaId"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!personas[input?.personaId]) throw new Error("Unknown personaId");
      state.selectedPersona = input.personaId;
      renderPersonas();
      renderResults();
      openPanel("simulation-panel");
      const result = simulate(state.card, personas[input.personaId]);
      return { personaId: input.personaId, ongoingCustomerValue: result.ongoingCustomerValue, ongoingContribution: result.ongoingContribution, costToSpendRatio: result.costToSpendRatio };
    },
  });

  register({
    name: "optimize_card_concept",
    title: "Optimize card concept",
    description: "Test up to five card configurations against customer-value, cost-ratio, and issuer-contribution constraints.",
    inputSchema: {
      type: "object",
      properties: {
        personaId: { type: "string", enum: Object.keys(personas) },
        minimumCustomerValue: { type: "number" },
        maximumCostPercent: { type: "number", minimum: 0, maximum: 20 },
        minimumContribution: { type: "number" },
      },
      required: ["personaId", "minimumCustomerValue", "maximumCostPercent", "minimumContribution"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!personas[input?.personaId]) throw new Error("Unknown personaId");
      $("#objective-persona").value = input.personaId;
      $("#objective-value").value = Number(input.minimumCustomerValue);
      $("#objective-cost").value = Number(input.maximumCostPercent);
      $("#objective-contribution").value = Number(input.minimumContribution);
      openPanel("optimize-panel");
      const output = await runOptimization();
      return { mode: output.mode, attempts: output.attempts.length, constraintsMet: output.recommended.status.met, recommendedCard: output.recommended.card };
    },
  });
}

function init() {
  populateForm();
  renderObjectivePersonas();
  refreshAll();
  wireEvents();
  registerWebMcpTools();
  renderMode();
  detectAI();
}

init();
