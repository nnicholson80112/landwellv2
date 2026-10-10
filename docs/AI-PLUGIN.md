# Plugging in a communication AI

Every message (text, email, voice turn) goes through one interface:

```ts
interface CommunicationAI {
  name: string;
  respond(input: AIInput): Promise<AIResult>;
}
```

The AI only **classifies and drafts**. It never sends anything or changes data
itself. The front-desk workflow (`src/workflows/inbound-message.ts`) does that:

1. **Guardrails before the AI** (`src/ai/guardrails.ts`). Emergencies, accommodation
   requests, fair-housing topics, application-decision questions and complaints get a
   fixed, reviewed reply and go to the owner. The AI never sees them.
2. **The AI** gets the message, recent history, the sender's role, and a list of
   **facts** it may state (rent, pet policy, showing hours…). That list is the only
   thing it is allowed to quote.
3. **Guardrails after the AI.** Steering phrases, promises ("you're approved") and
   any dollar amount that isn't in the facts block the draft; a safe reply goes out
   instead and the owner is told.
4. **The workflow acts** on the intent: starts a repair, a showing, a renewal answer…

## The in-house option (recommended): Landwell AI service

`src/ai-service/server.ts` is our own AI service. It runs as a second Railway service, and the main
app talks to it with `AI_PROVIDER=http`. It holds everything that makes the AI ours:

- **The prompt and house style**, versioned in this repo (`src/ai/prompt.ts`)
- **Swappable models**: Claude today (`AI_MODEL_PRIMARY=anthropic`). Later, a model you host yourself
  on a GPU server, through any OpenAI-compatible endpoint (`openai-compat`: vLLM, Ollama, TGI)
- **A fallback chain**: primary model, then backup model, then rules, so tenants always get an answer
- **Its own guardrail pass**, so a misconfigured caller can't skip the fair-housing checks
- **Logs of every exchange** (`AI_LOG_DIR`, kept 90 days) for reviewing quality and future training
- **`GET /stats`**: volume, intents, handoff rate, speed

What it needs: an Anthropic API key to start, or a GPU host such as RunPod, Modal or Lambda if you
later want the model itself in-house.

## Choosing a provider (`.env`)

| `AI_PROVIDER` | What runs | Needs |
| --- | --- | --- |
| `rules` (default) | Keyword rules, no network. Also the automatic fallback for the others | nothing |
| `anthropic` | Claude via the Messages API | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| `http` | Your own service, in-house or any vendor | `AI_HTTP_URL`, optional `AI_HTTP_TOKEN` |

If a model errors or takes longer than 15 seconds, the rule-based AI answers instead
and the error is logged. Tenants always get a reply.

## The HTTP contract (in-house AI)

Landwell sends `POST AI_HTTP_URL` with `Authorization: Bearer AI_HTTP_TOKEN` and this body:

```json
{
  "channel": "sms",
  "senderRole": "tenant",
  "senderName": "Lisa Chen",
  "message": "The kitchen faucet is dripping",
  "mediaCount": 0,
  "history": [{ "direction": "out", "body": "Hi Lisa! ..." }],
  "facts": [{ "label": "Rent due date", "value": "on the 1st of each month" }],
  "allowedIntents": ["emergency", "maintenance_request", "rent_question", "general"],
  "ownerFirstName": "Nate",
  "brandName": "Landwell"
}
```

Reply with:

```json
{
  "intent": "maintenance_request",
  "confidence": 0.9,
  "reply": "Sorry about that! Could you send a photo?",
  "entities": { "trade": "plumbing", "urgency": "routine", "summary": "Kitchen faucet dripping" },
  "handoff": false
}
```

Rules: `intent` must be one of `allowedIntents` (anything else becomes `general` and goes to
the owner). Vendor messages use `vendorAccept`, `vendorWindow`, `vendorQuote` (dollars),
`vendorDone`, `vendorInvoice` (dollars). Tenant renewal answers use `renewalAnswer`
(`accept` | `decline` | `question`). The full list is in `src/ai/types.ts`, and the prompt
the Claude provider uses is in `src/ai/prompt.ts`, which is a good starting point for an
in-house model.

## Voice

**Built in, no extra vendor:** point your Twilio number's "A call comes in" webhook at
`/webhooks/twilio/voice`. Twilio turns the caller's speech into text, Landwell answers through the
same front desk, and Twilio reads the reply aloud. Emergencies are transferred straight to the owner's
phone. To swap Twilio's voice for a more natural one or a faster streaming agent later, use the
generic endpoint below.

**Any voice agent:** point the agent (in-house, Retell, Vapi, Twilio ConversationRelay…) at
`POST /webhooks/voice`. For each caller turn it sends:

```json
{ "from": "+17205550111", "to": "+17205550199", "transcript": "My heat stopped working", "callId": "c_1", "turnId": "3" }
```

and speaks back the `reply` field of the response. The voice agent handles speech;
Landwell handles the brain, the guardrails and the workflows, the same as for texts.
Protect it with `VOICE_WEBHOOK_SECRET` (sent as a Bearer token).

## Testing a provider

```bash
AI_PROVIDER=http AI_HTTP_URL=http://localhost:9000/respond npm start
curl -X POST localhost:8787/api/dev/inbound -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' -d '{"from":"+17205550111","body":"Is rent due on the 1st?"}'
```
