"""RewardsLab AI backend.

Every prompt, tool definition, and model setting lives here, server-side. The
browser sends only task inputs (a brief, a claim, a question, or the running
optimization transcript), so the endpoint cannot be used as an open proxy.

The deterministic economics engine stays in the browser (dist/economics.mjs).
For the optimization agent, Claude proposes a configuration through the
`simulate_card` tool, the browser runs the simulator and returns the result,
and Claude iterates. The model never computes the numbers itself.

Runs as a Vercel Python function (`handler`) and is imported by local_server.py for
local use.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs

import anthropic

MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_BODY_BYTES = 200_000
MAX_AGENT_TRANSCRIPT = 16  # assistant + tool_result messages kept per optimization run
MAX_CHAT_TURNS = 12

_client: anthropic.Anthropic | None = None


def live_enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=90.0, max_retries=2)
    return _client


class TaskError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Prompt material, shared with the published artifact (dist/prompts.json)
# ---------------------------------------------------------------------------

PROMPTS = json.loads((Path(__file__).resolve().parent.parent / "dist" / "prompts.json").read_text())


def system_prompt(task: str) -> str:
    return f"{PROMPTS['domainContext']}\n\n{PROMPTS[task]['instructions']}"


PARSE_SYSTEM = system_prompt("parse")
PARSE_SCHEMA = PROMPTS["parse"]["schema"]
OPTIMIZE_SYSTEM = system_prompt("optimize")
OPTIMIZE_TOOLS = [{**tool, "strict": True} for tool in PROMPTS["optimize"]["tools"]]
CLAIMS_SYSTEM = system_prompt("claims")
CLAIMS_SCHEMA = PROMPTS["claims"]["schema"]
CHAT_SYSTEM = system_prompt("chat")


def compact(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# Claude call helpers
# ---------------------------------------------------------------------------


def call_claude(**params):
    """One Messages API call with refusal fallbacks and typed error handling."""
    try:
        response = client().beta.messages.create(
            model=MODEL,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            **params,
        )
    except anthropic.AuthenticationError as error:
        raise TaskError("The AI service rejected the API key.", 502) from error
    except anthropic.RateLimitError as error:
        raise TaskError("The AI service is busy right now. Try again shortly.", 503) from error
    except anthropic.BadRequestError as error:
        raise TaskError(f"The AI service rejected the request: {error.message}", 502) from error
    except anthropic.APIStatusError as error:
        raise TaskError(f"AI service error ({error.status_code}).", 502) from error
    except anthropic.APIConnectionError as error:
        raise TaskError("Could not reach the AI service.", 503) from error

    if response.stop_reason == "refusal":
        raise TaskError("The AI declined this request.", 422)
    if response.stop_reason == "max_tokens":
        raise TaskError("The AI's response was cut off. Try a shorter input.", 502)
    return response


def first_json(response) -> dict:
    text = next((block.text for block in response.content if block.type == "text"), None)
    if text is None:
        raise TaskError("The AI returned no structured output.", 502)
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise TaskError("The AI returned invalid JSON.", 502) from error


def sanitize_content(blocks: list[dict]) -> list[dict]:
    """Prepare assistant content for echoing back on the next agent turn.

    After a mid-output refusal fallback, thinking and tool_use blocks that
    precede the final `fallback` marker must not be replayed.
    """
    fallback_indexes = [i for i, block in enumerate(blocks) if block.get("type") == "fallback"]
    if not fallback_indexes:
        return blocks
    boundary = fallback_indexes[-1]
    dropped = {"thinking", "redacted_thinking", "tool_use", "server_tool_use"}
    return [
        block
        for i, block in enumerate(blocks)
        if i > boundary or (block.get("type") not in dropped and block.get("type") != "fallback")
    ]


def require_text(payload: dict, key: str, limit: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise TaskError(f"'{key}' is required.")
    if len(value) > limit:
        raise TaskError(f"'{key}' must be at most {limit} characters.")
    return value.strip()


def require_object(payload: dict, key: str) -> dict:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise TaskError(f"'{key}' must be an object.")
    return value


# ---------------------------------------------------------------------------
# Task: brief -> structured card rules
# ---------------------------------------------------------------------------

def task_parse(payload: dict) -> dict:
    brief = require_text(payload, "brief", 2000)
    card = require_object(payload, "card")
    response = call_claude(
        max_tokens=16000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": PARSE_SCHEMA}},
        system=PARSE_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": (
                    f"<current_configuration>{compact(card)}</current_configuration>\n"
                    f"<brief>{brief}</brief>"
                ),
            }
        ],
    )
    return first_json(response)


# ---------------------------------------------------------------------------
# Task: optimization agent (one step of a browser-driven tool loop)
# ---------------------------------------------------------------------------

def validate_transcript(transcript) -> list[dict]:
    if not isinstance(transcript, list):
        raise TaskError("'transcript' must be a list.")
    if len(transcript) > MAX_AGENT_TRANSCRIPT:
        raise TaskError("The optimization run exceeded its turn limit.")
    for index, message in enumerate(transcript):
        expected = "assistant" if index % 2 == 0 else "user"
        if not isinstance(message, dict) or message.get("role") != expected:
            raise TaskError("Transcript turns must alternate assistant / user.")
        content = message.get("content")
        if not isinstance(content, list):
            raise TaskError("Transcript content must be a list of blocks.")
        if expected == "user" and any(block.get("type") != "tool_result" for block in content):
            raise TaskError("User turns in the transcript may only carry tool results.")
    if transcript and transcript[-1]["role"] != "user":
        raise TaskError("The transcript must end with tool results.")
    return transcript


def task_optimize_step(payload: dict) -> dict:
    context = require_object(payload, "context")
    for key in ["card", "persona", "objective", "fixedAssumptions"]:
        require_object(context, key)
    transcript = validate_transcript(payload.get("transcript", []))

    kickoff = (
        f"<target_persona>{compact(context['persona'])}</target_persona>\n"
        f"<starting_configuration>{compact(context['card'])}</starting_configuration>\n"
        f"<fixed_assumptions>{compact(context['fixedAssumptions'])}</fixed_assumptions>\n"
        f"<objectives>{compact(context['objective'])}</objectives>\n"
        "Find a configuration that meets every objective. Begin."
    )
    response = call_claude(
        max_tokens=16000,
        output_config={"effort": "medium"},
        system=OPTIMIZE_SYSTEM,
        tools=OPTIMIZE_TOOLS,
        messages=[{"role": "user", "content": kickoff}, *transcript],
    )
    content = sanitize_content(response.to_dict()["content"])
    return {"content": content, "stopReason": response.stop_reason}


# ---------------------------------------------------------------------------
# Task: marketing claims review
# ---------------------------------------------------------------------------

def task_claims(payload: dict) -> dict:
    claim = require_text(payload, "claim", 1500)
    card = require_object(payload, "card")
    portfolio = payload.get("portfolio")
    rule_findings = payload.get("ruleFindings", [])
    if not isinstance(portfolio, list) or not portfolio:
        raise TaskError("'portfolio' must be a non-empty list.")
    response = call_claude(
        max_tokens=16000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": CLAIMS_SCHEMA}},
        system=CLAIMS_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": (
                    f"<card_terms>{compact(card)}</card_terms>\n"
                    f"<simulated_results>{compact(portfolio)}</simulated_results>\n"
                    f"<rule_based_findings>{compact(rule_findings)}</rule_based_findings>\n"
                    f"<proposed_claim>{claim}</proposed_claim>"
                ),
            }
        ],
    )
    return first_json(response)


# ---------------------------------------------------------------------------
# Task: analyst chat grounded in the current workspace
# ---------------------------------------------------------------------------

def task_chat(payload: dict) -> dict:
    question = require_text(payload, "question", 1000)
    snapshot = require_object(payload, "snapshot")
    history = payload.get("history", [])
    if not isinstance(history, list) or len(history) > MAX_CHAT_TURNS * 2:
        raise TaskError("Chat history is too long. Clear the chat and try again.")
    messages = []
    for index, turn in enumerate(history):
        role = "user" if index % 2 == 0 else "assistant"
        if not isinstance(turn, dict) or turn.get("role") != role or not isinstance(turn.get("text"), str):
            raise TaskError("Chat history turns must alternate user / assistant text.")
        messages.append({"role": role, "content": turn["text"][:4000]})
    messages.append(
        {
            "role": "user",
            "content": f"<workspace_snapshot>{compact(snapshot)}</workspace_snapshot>\n{question}",
        }
    )
    response = call_claude(
        max_tokens=16000,
        output_config={"effort": "low"},
        system=CHAT_SYSTEM,
        messages=messages,
    )
    answer = "\n\n".join(block.text for block in response.content if block.type == "text").strip()
    if not answer:
        raise TaskError("The AI returned an empty answer.", 502)
    return {"answer": answer}


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

TASKS = {
    "parse": task_parse,
    "optimize-step": task_optimize_step,
    "claims": task_claims,
    "chat": task_chat,
}


def health() -> dict:
    return {"live": live_enabled(), "model": MODEL if live_enabled() else None}


def handle_api(method: str, path: str, body: bytes) -> tuple[int, dict]:
    """Shared by the Vercel function and the local server. Returns (status, json)."""
    raw_path, _, query = path.partition("?")
    # On Vercel, /api/<task> is rewritten to /api/index?route=<task> (see vercel.json).
    route = parse_qs(query).get("route", [raw_path.rstrip("/").removeprefix("/api/")])[0]
    if method == "GET" and route == "health":
        return 200, health()
    if method != "POST" or route not in TASKS:
        return 404, {"error": "Not found"}
    if not live_enabled():
        return 503, {"error": "Live AI is not configured. Set ANTHROPIC_API_KEY to enable it."}
    if len(body) > MAX_BODY_BYTES:
        return 413, {"error": "Request is too large."}
    try:
        payload = json.loads(body or b"{}")
        if not isinstance(payload, dict):
            raise TaskError("Request body must be a JSON object.")
        return 200, TASKS[route](payload)
    except json.JSONDecodeError:
        return 400, {"error": "Request body must be valid JSON."}
    except TaskError as error:
        return error.status, {"error": str(error)}


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime looks for this name
    def _respond(self, status: int, data: dict) -> None:
        encoded = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        self._respond(*handle_api("GET", self.path, b""))

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._respond(413, {"error": "Request is too large."})
            return
        self._respond(*handle_api("POST", self.path, self.rfile.read(length)))
