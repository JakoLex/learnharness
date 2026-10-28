# Fallback model

Each model slot (Strong, Cheap, Vision) can name an optional **fallback**: a second model that answers when the slot's model fails before it produces anything. Owner-approved 2026-10-28.

## Settings

- `settings.json` → `models.<slot>.fallback: { model: { provider, id }, thinkingLevel? }`. Same shape and rules as the slot itself: a fallback needs a model, its thinking level clamps against the fallback's own model on write, and an unset level resolves from `DEFAULT_THINKING_ORDER` at engine build.
- Settings → Agent → Models shows a "‹Slot› fallback" row under every configured slot ("None" until picked, ✕ removes it).
- Resolution (`src/core/settings-resolution.ts`): chats run their own model with the **strong** slot's fallback; every background role runs its resolved model (role override included) with its **tier's** fallback. A fallback naming the very model it backs up resolves to none.
- Subscription routes (ChatGPT, Copilot, Grok) take no part: a subscription primary never falls back (the upstream rule in [architecture](architecture.md) stands) and a subscription is never a fallback (the picker hides them, the write refuses them).

## Behavior (`src/agent/model-fallback.ts`)

One wrapper around the stream function of the one engine factory (`piEngineForSpec`), so turns, sub-agents, extraction and compaction all inherit it.

- **Trigger: an error before the first token.** The primary's `start` event is held until content arrives, so an error right after the HTTP response opened still falls back and the agent loop never sees a half-started primary message. The fallback answers the same request with its own model and thinking level.
- **Not a trigger:** a user abort, and a break mid-answer — the partial answer is the primary's and keeps today's error + Retry.
- **Down-mark:** availability failures (network, timeout, 429/5xx, auth, quota — pi-ai's `isRetryableAssistantError` plus auth/quota patterns) mark the primary down for **5 minutes**, process-wide: calls skip it and go straight to the fallback. Request-specific failures (another 4xx) fall back without the mark.
- **Both fail:** the error names both (`<primary> failed: … / Fallback <fallback> failed: …`) and the usual Retry applies.
- **Key gates:** a turn, job or extraction stage whose primary key is missing still runs when its fallback's key is present.

## Presentation and accounting

- The answering message carries a `lh.model_fallback` entry in pi's native `diagnostics` (persisted with the record, never sent to a provider). The transcript shows "via ‹fallback› — ‹primary› unavailable" once per assistant group; the primary's error is the tooltip.
- The activity dock lists each marked-down primary ("‹model› unavailable — fallback until HH:MM") until the mark expires.
- `CallUsage.model` stamps a call a fallback ran (turns and job calls); pricing uses it per call. The context panel names the fallback in the turns list and in the headline's model line.

## Known limit

The compaction threshold follows the primary's context window. A fallback with a smaller window can fail on a long session; that surfaces as the normal error.
