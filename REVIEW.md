<!-- Maintained for the AI-37 doc-bot PR reviewer. Repo-specific overlay; the common review
     contract (three lenses, false-positive rules, autonomy) is the bot's built-in prompt —
     canonical text in AI-37/docs plans/doc-bot-pr-review/reviews/_common.md. -->

# REVIEW.md — ai37-agent-sdk
> Inherits the common contract: reviews/_common.md (the bot loads it as the global default). This file covers only the repo-specific specifics.

**Role / stack / deploy:** the ecosystem's agent SDK — cross-cutting auth (verifying the user-JWT against JWKS), billing (runtime state, metered usage, `llmKey`, denial gate on `entitlementStatus`), A2A-forward of the same user-JWT, the `AgentContext` wrapper; plus the agent host layer. A monorepo of two implementations sharing one contract: TS (Node ≥22, npm, tsup) + Python (≥3.11, poetry, ruff/mypy/pytest). Deploy: **a library, not a service** — publishing to **npm (`@ai37/agent-sdk`, `@ai37/agent-host`, `@ai37/docx`) + PyPI (`ai37-agent-sdk`, `ai37-agent-host`)** via GitHub Actions (`publish-*.yml`); Helm/terraform are NOT used.

**Test command:** `make verify` — this is the only full gate. It: (1) `make codegen` + a `git diff --exit-code` check on `packages/ts/src/codes.ts` and `packages/python/src/ai37_agent_sdk/codes.py` (parity of codegen vs `contract/feature-codes.json`); (2) `make ts` (`npm ci && npm run lint (tsc --noEmit) && vitest run && tsup`); (3) `make ts-docx`; (4) `make py` (`poetry install --with dev && ruff check . && mypy src && pytest`). Targeted: `make ts` / `make py` / `make ts-docx`. **A change under `contract/` without the corresponding codegen/`codes.*` commit is a finding** (the parity gate is red, but call it out explicitly as contract drift).

**Key invariants (what the reviewer must know):**
- **The public API is TS↔Python parity.** Any name/signature/semantics exported from `packages/ts` (`index.ts`, the `./testing` and `./dev` subpaths) MUST have an identical counterpart in `packages/python` (`__init__.py`) with the same behavior. A PR that adds/changes a public symbol in one implementation and not the other drives the agents into divergence — a strong objection.
- **`contract/` is the source of truth.** `feature-codes.json` → codegen → `codes.ts`+`codes.py`; `billing-runtime-state.schema.json` (including `entitlementStatus`), `claims.schema.json`, `a2a-routing-extension.schema.json`. Manually editing `codes.ts`/`codes.py` while bypassing codegen, or editing a schema without updating both implementations, is a contract regression.
- **The order and semantics of billing denial are fixed:** `entitlementStatus != 'active'` → denial; `payment_failed` is checked FIRST (`PAYMENT_FAILED`), `no_resources` → `NO_TOKENS`; user-facing text comes only from the single `BILLING_USER_MESSAGES`/`billing_user_message` map. Changing the order/codes/messages hits all agents and the denial UX.
- **`llmKey` comes only from runtime state (billing preflight), NOT from env/JWT/body.** Secrets (`Authorization`, `llmKey`, `authToken`) are never logged. A PR that pulls the key from another source or adds it to a log/trace/Langfuse is a security blocker.
- **The SDK does not perform OIDC login** (Authorization Code+PKCE, code exchange, refresh, session) and does not perform token-exchange — only verify + forward of the same user-JWT. Login/delegation code here is an architectural dead end (wrong layer).
- **The `AgentContext` contract (verify → billing preflight → LLM → domain → `reportUsage`)** is the shared sequence for all agents. `reportUsage` only after success; skipping usage or preflight is a billing hole across all consumers.

**Lens 2 — what to check against (docs/ecosystem):** `ecosystem/v2/09-agent-runtime.md` (agent runtime, host layer), `ecosystem/v2/02-authentication.md` (JWT-verify, JWKS, issuer/audience), `ecosystem/v2/03-billing.md` (entitlement/`entitlementStatus`, metered usage, `llmKey`), `ecosystem/v2/04-a2a-conventions.md` (forward user-JWT, `a2a-routing-extension`, output modes/`confirm_mode`). Identity (`billing_org_id`/`org_id`) comes only from a verified claim, not from the A2A body.

**Sensitive paths (in addition to the default):**
- `contract/**` — the contract's source of truth (schemas + feature-codes); a change ripples across all agents and both implementations.
- `packages/*/src/auth/**`, `packages/*/src/billing/**`, `packages/*/src/a2a/**` — auth/billing/forward are already covered by the default (`**/auth/**`, `**/billing/**`), but HERE they are also the library's public API.
- **Public API + version:** `packages/ts/src/index.ts`, `packages/python/src/ai37_agent_sdk/__init__.py`, the `version`/`exports` fields in `packages/*/package.json` and `packages/*/pyproject.toml`, `.github/workflows/publish-*.yml`, `CHANGELOG.md`.
- Host layer: `packages/ts-host/**`, `packages/python-host/**` — the public packages `@ai37/agent-host`/`ai37-agent-host` (A2A/AG-UI/MCP/Redis task store/observability; durable checkpointer).
- `scripts/codegen.mjs` — the `codes.*` generator; changing it changes the output for all consumers.

**Autonomy threshold (refinement):** this is a published library sitting under all agents — **never auto-approve** for: (a) any public-API change (adding/renaming/removing an export, changing a signature) in TS or Python; (b) breaking changes to semantics (billing-denial order/codes, forward-header format, the `AgentContext` contract); (c) a version bump in `package.json`/`pyproject.toml` or changes to `publish-*.yml`; (d) edits to `contract/**` and `scripts/codegen.mjs`. All of this → `comment` + escalate to a human (the owners). A missing parity change in the other implementation, or a change to a public symbol without a meaningful test on real input, is `request_changes`.

Write the review summary and all inline comments in RUSSIAN (the developers read Russian); these instructions are in English only for your understanding.
