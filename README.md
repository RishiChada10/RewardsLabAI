# RewardsLab AI

An AI-native concept studio for credit-card rewards products. A product manager describes a card in plain language; Claude turns it into editable rules, an agent searches for a configuration that meets measurable objectives, a reviewer checks marketing claims, and an analyst answers questions about the concept. Each number comes from a deterministic economics engine that Claude can call but cannot override.

> **AI proposes. The simulator verifies. A human decides.**

## Start on a Mac

1. Copy `.env.example` to `.env` and paste your Anthropic API key after `ANTHROPIC_API_KEY=`.
2. Double-click `start.command`. On first run it creates a private Python environment and installs the Claude SDK.
3. If macOS blocks it, right-click the file, choose **Open**, and confirm.
4. Your browser opens `http://localhost:8080`. Keep the Terminal window open; press `Control-C` to stop.

Without a key the app still runs in **offline mode**, using the deterministic parser and rule-based optimizer. With a key, the **Live AI** switch in the header lets you flip between modes during a demo.

## How the AI is used

| Step | Live AI (Claude Opus 5.5) | Offline fallback |
| --- | --- | --- |
| 1. Design | Brief → complete card config via structured outputs (JSON schema), with a rationale for every change, stated assumptions, and anything the engine cannot model | Keyword parser |
| 2. Simulate | Deterministic engine for every persona (no AI involved) | Same |
| 3. Optimize | Tool-using agent: Claude forms a hypothesis, calls `simulate_card`, reads the gaps to each objective, iterates (max 5 simulations), then calls `submit_recommendation` with trade-offs and the next validation step | Fixed if/else rules |
| 4. Claims check | Claude reviews the claim against configured terms and every persona result, cites evidence, and drafts a compliant rewrite; rule checks run alongside | Rule checks only |
| 5. Ask the analyst | Q&A grounded in a snapshot of the live workspace | Not available |

Every live call falls back to the offline engine on any error, so a lost connection in the middle of a demo does not break it.

## Architecture

```
dist/                Static front end (vanilla JS)
  economics.mjs      Deterministic economics engine and offline parser/optimizer
  app.js             UI, and the agent loop that runs simulate_card in the browser
api/index.py         Claude backend: prompts, schemas, tools, and model settings
local_server.py      Local server: serves dist/ and routes /api/* to api/index.py
tests/test_api.py    Backend tests with a fake Claude client (no API spend)
vercel.json          Deployment config (static site + Python function)
```

Design choices worth noting:

- **The model never computes the economics.** The agent can only propose configurations; the simulator scores them and the UI reports what the simulator found, even when it contradicts the model's summary.
- **The backend is not an open proxy.** Prompts, tool definitions, model, and effort live server-side. The browser sends only task inputs, and transcripts are validated so user turns can contain tool results only.
- **The agent loop is bounded:** 5 simulations and 8 model turns. Claude's thinking blocks are passed back unchanged between steps.
- Strict tool schemas and structured outputs give schema-valid responses; server-side refusal fallbacks are enabled.

## Financial model

Interchange revenue on spend; points issued and redeemed after breakage; separate customer value and issuer cost per point; the welcome offer as a one-time cost; annual fee and benefits cost; year-one and ongoing contribution; and rewards-plus-benefits cost as a percentage of spend.

It excludes revolving interest, credit and fraud losses, servicing, processing, taxes, adoption, attrition, underwriting, and full customer lifetime value. Outputs are concept-screening estimates, not a profitability forecast.

## Publish as a Claude artifact (no API key)

`.venv/bin/python scripts/build_artifact.py` builds `build/artifact/` for publishing as a claude.ai artifact with the `sample` capability. In that version, viewers signed in to Claude run the live AI on their own Claude account (they are asked to allow it on first use). Everyone else gets offline mode. Prompts come from the same `dist/prompts.json` the backend uses.

## Deploy (Vercel)

1. Push this folder to a GitHub repository (`.env` and `.venv/` are git-ignored).
2. Import the repository at vercel.com. No build command is needed; `vercel.json` serves `dist/` and deploys `api/index.py` as a Python function.
3. Add `ANTHROPIC_API_KEY` under **Settings → Environment Variables**, then redeploy.
4. Set a monthly spend limit on the API key, since the deployed link is public.

## Tests

```bash
.venv/bin/python -m unittest discover tests
```

## Responsible use

- No customer or employer data is used. Personas are fictional.
- AI recommendations are editable and require human approval before they are applied.
- The claims check supports human review; it is not legal or regulatory approval.
