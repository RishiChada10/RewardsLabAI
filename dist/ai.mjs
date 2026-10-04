// Live AI providers. Both expose the same four tasks, use the same prompts
// (prompts.json), and share the same tool handlers, so the UI does not care
// which one is answering:
//
// - "server": the Python backend (api/index.py) calls the Anthropic API with
//   the deployer's key. Used by the local app and a Vercel deployment.
// - "sample": inside a published Claude artifact, the page asks Claude on the
//   viewer's own Claude account via the `sample` capability. No key, no server.
//
// When neither is available the app runs in offline mode.

const MAX_AGENT_TURNS = 8;

async function loadPrompts() {
  const response = await fetch("./prompts.json", { cache: "no-store" });
  if (!response.ok) throw new Error("prompts.json missing");
  return response.json();
}

async function postJSON(route, body) {
  let response;
  try {
    response = await fetch(`./api/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the AI backend");
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* non-JSON error page */
  }
  if (!response.ok) throw new Error(data.error || `AI request failed (${response.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Server provider (Anthropic API behind api/index.py)
// ---------------------------------------------------------------------------

function serverProvider(model) {
  return {
    kind: "server",
    label: { "claude-opus-5-5": "Claude Opus 5.5" }[model] || model || "Claude",
    canOptimize: true,
    chatNeedsKey: false,
    parse: (brief, card) => postJSON("parse", { brief, card }),
    claims: (payload) => postJSON("claims", payload),
    chat: async (question, history, snapshot) => (await postJSON("chat", { question, history, snapshot })).answer,

    // The browser runs the tool loop; the server adds prompts and calls Claude.
    async optimize(context, handlers) {
      const transcript = [];
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
        const step = await postJSON("optimize-step", { context, transcript });
        transcript.push({ role: "assistant", content: step.content });
        const toolUses = step.content.filter((block) => block.type === "tool_use");
        if (!toolUses.length) return;

        const results = [];
        let submitted = false;
        for (const toolUse of toolUses) {
          try {
            const output = toolUse.name === "simulate_card"
              ? handlers.simulate_card(toolUse.input)
              : toolUse.name === "submit_recommendation"
                ? handlers.submit_recommendation(toolUse.input)
                : (() => { throw new Error(`Unknown tool ${toolUse.name}`); })();
            submitted ||= toolUse.name === "submit_recommendation";
            results.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(output) });
          } catch (error) {
            results.push({ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: error.message });
          }
        }
        transcript.push({ role: "user", content: results });
        if (submitted) return;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sample provider (Claude artifact, viewer's own Claude account)
// ---------------------------------------------------------------------------

const SAMPLE_ERRORS = {
  not_granted: "Claude access for this page was declined",
  sampling_disabled: "Claude is not available for this account",
  rate_limited: "Claude usage limit reached; try again later",
  session_expired: "sign in to Claude again",
  refused: "Claude declined this request",
  invalid_json: "Claude's answer was not valid JSON",
  tools_unavailable: "this view cannot run the agent's tools",
  cancelled: "cancelled",
};

function sampleError(error) {
  return new Error(SAMPLE_ERRORS[error?.code] || error?.message || "Claude request failed");
}

function samplePrompt(prompts, task, data, format) {
  return [prompts.domainContext, prompts[task].instructions, data, format].filter(Boolean).join("\n\n");
}

function jsonFormat(schema) {
  return `Reply with only one JSON object, no other text, matching this JSON Schema:\n${JSON.stringify(schema)}`;
}

function sampleProvider(sample, prompts, canUseTools) {
  return {
    kind: "sample",
    label: "Claude (your account)",
    canOptimize: canUseTools,
    async parse(brief, card) {
      const data = await sample
        .json(samplePrompt(prompts, "parse", `<current_configuration>${JSON.stringify(card)}</current_configuration>\n<brief>${brief}</brief>`, jsonFormat(prompts.parse.schema)))
        .catch((error) => { throw sampleError(error); });
      if (!data?.card || typeof data.card !== "object") throw new Error("Claude's answer had no card configuration");
      return {
        card: data.card,
        rationale: Array.isArray(data.rationale) ? data.rationale : [],
        assumptions: Array.isArray(data.assumptions) ? data.assumptions : [],
        unsupported: Array.isArray(data.unsupported) ? data.unsupported : [],
      };
    },
    async claims({ claim, card, portfolio, ruleFindings }) {
      const input = [
        `<card_terms>${JSON.stringify(card)}</card_terms>`,
        `<simulated_results>${JSON.stringify(portfolio)}</simulated_results>`,
        `<rule_based_findings>${JSON.stringify(ruleFindings)}</rule_based_findings>`,
        `<proposed_claim>${claim}</proposed_claim>`,
      ].join("\n");
      const data = await sample
        .json(samplePrompt(prompts, "claims", input, jsonFormat(prompts.claims.schema)))
        .catch((error) => { throw sampleError(error); });
      return {
        findings: (Array.isArray(data?.findings) ? data.findings : []).filter((item) => item?.title),
        suggestedRewrite: String(data?.suggestedRewrite || ""),
      };
    },
    async chat(question, history, snapshot) {
      const turns = [
        { role: "user", content: `${prompts.domainContext}\n\n${prompts.chat.instructions}` },
        ...history.map(({ role, text }) => ({ role, content: text })),
        { role: "user", content: `<workspace_snapshot>${JSON.stringify(snapshot)}</workspace_snapshot>\n${question}` },
      ];
      const { text } = await sample(turns, { cache: false }).catch((error) => { throw sampleError(error); });
      return text.trim();
    },
    async optimize(context, handlers) {
      if (!canUseTools) throw new Error(SAMPLE_ERRORS.tools_unavailable);
      const kickoff = [
        `<target_persona>${JSON.stringify(context.persona)}</target_persona>`,
        `<starting_configuration>${JSON.stringify(context.card)}</starting_configuration>`,
        `<fixed_assumptions>${JSON.stringify(context.fixedAssumptions)}</fixed_assumptions>`,
        `<objectives>${JSON.stringify(context.objective)}</objectives>`,
        "Find a configuration that meets every objective. After submit_recommendation, reply with one short sentence.",
      ].join("\n");
      const tools = prompts.optimize.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        execute: (input) => handlers[tool.name](input),
      }));
      await sample(samplePrompt(prompts, "optimize", kickoff), { tools }).catch((error) => { throw sampleError(error); });
    },
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectProvider() {
  let prompts;
  try {
    prompts = await loadPrompts();
  } catch {
    return { provider: null, reason: "AI prompts could not be loaded" };
  }

  try {
    const health = await (await fetch("./api/health", { cache: "no-store" })).json();
    if (health.live) return { provider: serverProvider(health.model) };
  } catch {
    /* no backend: static host or Claude artifact */
  }

  let sample = null;
  try {
    sample = (await window.claude?.use?.("sample")) ?? null;
  } catch {
    /* not inside a Claude viewer */
  }
  if (sample) {
    const limits = await sample.limits().catch(() => null);
    return { provider: sampleProvider(sample, prompts, Boolean(limits?.tools)) };
  }
  return { provider: null, reason: "No AI backend and not opened inside Claude" };
}
