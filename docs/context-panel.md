# Context panel

Clicking the stats bar's context · cost summary opens the context panel
(`components/context-dialog.tsx`). It replaced the session-stats popover and
carries its turns list.

## Headline

The headline is the **measured** conversation meter (see
[compaction accounting](compaction-accounting.md#conversation-meter)): the
latest qualifying response's `input + output + cacheRead + cacheWrite` over the
selected model's catalog limit. It is `?` after a successful compaction until
the next reply. The bar fills to that measured share.

## What fills the window

The buckets only divide the measured fill. They are **estimates** and never
replace the measurement.

| Bucket | Counted from the request |
| --- | --- |
| System instructions | system message text and sections |
| Tool definitions | `toolsAdded` as JSON `{name, description, parameters}` |
| Conversation text | user and assistant text |
| Reasoning | visible thinking; redacted thinking (an opaque signature) counts 0 |
| Tool calls and results | tool-call name + JSON arguments, tool-result text |
| Images | a fixed 1,200 tokens each (the compaction port's allowance) |

Text is estimated at four ASCII characters per token and at least one token
per other UTF-16 unit, so umlauts and math symbols are not undercounted.

**Recording.** `prepareRequest` (src/agent/teacher-agent.ts) estimates
`toLlmMessages(request.context.messages)` — exactly what is sent, with the
leading system message carrying the prompt and the tool declarations — just
before each model call. The chat handler pairs it with that call's usage and
persists it as `CallUsage.context` in the turns log. Only the conversation
agents (prober, teacher, practice) record it; background jobs and the
compaction summarizer do not. An unbilled call (aborted, refused usage) records
nothing. A failed estimate is logged and never affects the request.

**Fallback.** Calls recorded before the panel existed have no
`CallUsage.context`. The panel then estimates the transcript up to the latest
assistant message through the same conversion. The record never holds the
system message, so system instructions and tool definitions read "not
recorded" until the next reply.

## Cards

- **Last request** — the latest turn's last call: input, cache read, cache
  write, output, reasoning tokens.
- **Session** — messages (the learner's native inputs: typed messages, steers,
  answers, practice submissions; and the agent's replies), total cost (the
  stats bar's server-priced label), unpriced turns, creation time, and last
  activity (the newest message timestamp).

## Upstream attribution

The panel is adapted from **OpenScience**
(<https://github.com/synthetic-sciences/openscience>, commit `c971e7f`),
licensed under the Apache License 2.0 — full text in
[third-party/openscience-LICENSE.txt](third-party/openscience-LICENSE.txt).
Adapted parts:

- `src/core/context-composition.ts` — from OpenScience's `Token.estimate`
  (`backend/cli/src/util/token.ts`), `MessageV2.composition` and `toolTokens`
  (`backend/cli/src/session/message-v2.ts`, `backend/cli/src/session/prompt.ts`),
  and `contextSegments`
  (`frontend/workspace/src/components/session/context-composition.ts`).
  Changed: runs on pi's provider wire instead of OpenScience message parts;
  no skills/documents buckets; images at a fixed allowance.
- `components/context-dialog.tsx` — the layout of OpenScience 2.0.151's
  "Context" dialog and the bar/legend logic of
  `frontend/workspace/src/components/session/session-context-tab.tsx`.
  Changed: React instead of Solid, LearnHarness's measured meter as the
  headline, the session-stats turns list.

Attribution notices from OpenScience's NOTICE file that pertain to these parts:

```
OpenScience
Copyright 2026 Synthetic Sciences

This product includes software developed at Synthetic Sciences.
Licensed under the Apache License, Version 2.0.

--------------------------------------------------------------------------------
OpenCode
https://github.com/anomalyco/opencode · https://opencode.ai

OpenScience is inspired by OpenCode and its work toward excellent open-source
agents. OpenScience applies that inspiration to making strong, open-source
scientific agents available to everyone.

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
