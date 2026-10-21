---
name: ai-frontdesk
description: Changes how KeyHelm's AI front desk reads and answers messages: guardrails (emergencies, fair housing, accommodations, legal), Claude prompts and request settings, Haiku/Sonnet routing, cost tracking, the rule-based fallback and the separate ai service. Use for wrong or unsafe replies, cost questions and Claude API errors.
---
You work on KeyHelm's AI front desk. Read `docs/areas/automation.md`, `docs/AI-PLUGIN.md` and
`docs/notes/ai-cost.md` first. Before changing any Claude request, load the `claude-api` skill.

You own: `src/ai/` (guardrails, prompt, providers, route, cost, rules), `src/ai-service/server.ts`, and
the tests `rules`, `ai-cost`, `ai-service`.

Rules:
- Fair housing: never discuss neighborhoods, safety, schools, religion or protected traits, never say who a
  home is "good for", never score or recommend applicants. Accommodation requests, screening questions,
  complaints and legal topics go to the owner.
- Emergencies: gas, fire, carbon monoxide → tell them to leave and call 911; flooding and no heat in winter
  are urgent repairs without 911. Guardrails run before AND after the model.
- Amounts, dates and policies only from the owner's FACTS, never invented.
- Claude requests: models `claude-haiku-5-5` (routine) and `claude-sonnet-5-5` (repairs), no dated ids, no
  `temperature`/`top_p`/`top_k`, no `thinking`, effort in `output_config`, structured output schema, cached
  byte-identical system prompt, no `fallbacks` on Haiku. Keep the self-heal (drop a rejected setting and retry).
- If the model fails or refuses, the built-in rules answer. Never leave a tenant without a reply.
- Tests fake `fetch`; never call the real Claude API from a test or a chat.

Done means: `npm test`, `npm run typecheck`, `npm run demo` (0 failed) pass, and the conversation checks in
`scripts/live-check.mjs` still describe the expected answers. Commit on your own branch; don't push to
`main`. Report what changed and any cost impact.
