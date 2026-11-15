# Repository Guidelines

- Kvant is an AI agent for the Russian market (MOEX, Bank of Russia, IFRS via smart-lab, GigaChat) aimed at retail investors: a CLI and a web edition (`src/web/`, `web/public/`).
- User-facing text, prompts and skills are in Russian.

## Project Structure

- Source code: `src/`
  - Agent core: `src/agent/` (agent loop, prompts, scratchpad, token counting, types)
  - CLI interface: `src/cli.tsx` (Ink/React), entry point: `src/index.tsx`
  - Components: `src/components/` (Ink UI components)
  - Hooks: `src/hooks/` (React hooks for agent runner, model selection, input history)
  - Model/LLM: `src/model/llm.ts` (multi-provider LLM abstraction)
  - Tools: `src/tools/` (financial search, web search, browser, skill tool)
  - Tool descriptions: `src/tools/descriptions/` (rich descriptions injected into system prompt)
  - Finance tools: `src/tools/finance/` (prices, fundamentals, filings, insider trades, etc.)
  - Search tools: `src/tools/search/` (Exa preferred, Tavily fallback)
  - Browser: `src/tools/browser/` (Playwright-based web scraping)
  - Skills: `src/skills/` (SKILL.md-based extensible workflows, e.g. DCF valuation)
  - Utils: `src/utils/` (env, config, caching, token estimation, markdown tables)
  - Evals: `src/evals/` (LangSmith evaluation runner with Ink UI)
- Config: `.kvant/settings.json` (persisted model/provider selection)
- Environment: `.env` (API keys; see `env.example`)
- Scripts: `scripts/release.sh`

## Build, Test, and Development Commands

- Runtime: Bun (primary). Use `bun` for all commands.
- Install deps: `bun install`
- Run: `bun run start` or `bun run src/index.tsx`
- Dev (watch mode): `bun run dev`
- Type-check: `bun run typecheck`
- Tests: `bun test`
- Evals: `bun run src/evals/run.ts` (full) or `bun run src/evals/run.ts --sample 10` (sampled)
- CI runs `bun run typecheck` and `bun test` on push/PR.

## Coding Style & Conventions

- Language: TypeScript (ESM, strict mode). JSX via React (Ink for CLI rendering).
- Prefer strict typing; avoid `any`.
- Keep files concise; extract helpers rather than duplicating code.
- Add brief comments for tricky or non-obvious logic.
- Do not add logging unless explicitly asked.
- Do not create README or documentation files unless explicitly asked.

## LLM Providers

- Default: GigaChat via `src/model/gigachat.ts` (own adapter; `langchain-gigachat` breaks zod v4 schemas). `GIGACHAT_MODEL` sets the model, TLS needs `NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem`.
- Also supported: OpenAI (`gpt-`), Anthropic, Google, xAI, OpenRouter, Ollama. Unprefixed model names resolve to GigaChat.
- Fast models for lightweight tasks: see `FAST_MODELS` map in `src/model/llm.ts`.
- Anthropic uses explicit `cache_control` on system prompt for prompt caching cost savings.
- Users switch providers/models via `/model` command in the CLI.

## Tools

- Russian market tools live in `src/tools/ru/` (`tools.ts` defines them): `find_instrument`, `get_quotes`, `get_price_history`, `get_company_financials`, `get_dividends`, `screen_stocks`, `get_bonds`, `get_macro`, `get_news`, `analyze_portfolio`, `plan_savings`, `draft_order`.
- Sources: MOEX ISS (`moex.ts`), Bank of Russia (`cbr.ts`), smart-lab (`smartlab.ts`), RSS (`news.ts`). All keyless; `http.ts` holds the TTL cache.
- Portfolio and savings math is deterministic code (`portfolio.ts`, `savings.ts`); the model only explains results.
- `draft_order` never executes trades.
- `web_fetch` refuses private/LAN addresses (`src/tools/fetch/egress-guard.ts`).
- Agent tools: `web_fetch`, `web_search`, `browser`, file tools, `bash`, memory, cron, `skill`, `spawn_subagent`. The web edition allows only data tools (see `WEB_TOOL_NAMES` in `src/web/server.ts`).
- Live smoke test without an LLM: `bun run smoke:tools`. Agent eval on Russian questions: `bun run eval:ru`.

## Skills

- Skills live as `SKILL.md` files with YAML frontmatter (`name`, `description`) and markdown body (instructions).
- Built-in skills: `src/skills/dcf` (RUB WACC), `src/skills/portfolio-review`, `src/skills/bond-ladder`.
- Discovery: `src/skills/registry.ts` scans for SKILL.md files at startup.
- Skills are exposed to the LLM as metadata in the system prompt; the LLM invokes them via the `skill` tool.

## Agent Architecture

- Agent loop: `src/agent/agent.ts`. Iterative tool-calling loop with configurable max iterations (default 10).
- Scratchpad: `src/agent/scratchpad.ts`. Single source of truth for all tool results within a query.
- Context management: Anthropic-style. Full tool results kept in context; oldest results cleared when token threshold exceeded.
- Final answer: generated in a separate LLM call with full scratchpad context (no tools bound).
- Events: agent yields typed events (`tool_start`, `tool_end`, `thinking`, `answer_start`, `done`, etc.) for real-time UI updates.

## Environment Variables

- LLM keys: `GIGACHAT_CREDENTIALS` (+ `GIGACHAT_SCOPE`, `GIGACHAT_MODEL`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`
- Ollama: `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- Web: `PORT`, `HOST`, `WEB_MODEL`, `WEB_DAILY_LIMIT`, `WEB_SESSION_HOURLY_LIMIT`, `WEB_MAX_CONCURRENT_RUNS`
- Search: `EXASEARCH_API_KEY` (preferred), `TAVILY_API_KEY` (fallback)
- Tracing: `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING`
- Never commit `.env` files or real API keys.

## Version & Release

- Version format: SemVer `MAJOR.MINOR.PATCH`. Tag prefix: `v`.
- Release script: `bash scripts/release.sh [version]` (defaults to today's date).
- Release flow: bump version in `package.json`, create git tag, push tag, create GitHub release via `gh`.
- Do not push or publish without user confirmation.

## Testing

- Framework: Bun's built-in test runner (primary), Jest config exists for legacy compatibility.
- Tests colocated as `*.test.ts`.
- Run `bun test` before pushing when you touch logic.

## Security

- API keys stored in `.env` (gitignored). Users can also enter keys interactively via the CLI.
- Config stored in `.kvant/settings.json` (gitignored).
- Never commit or expose real API keys, tokens, or credentials.
