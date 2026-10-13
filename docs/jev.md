# Jev (TypeSafe AI) — fast decisions around a turn

`src/modules/jev/service.ts`. Jev answers typed yes/no, score and choice questions with a calibrated probability and no text. The reactive turn (`src/graph/runtime.ts`) asks it twice:

1. **Before the model**, about the customer's message: is it a bare acknowledgement, did they ask for a person, how frustrated are they, which intent.
2. **After the model**, about the reply: does it break the operator's rules (`outputCheck`).

Off unless the instance has `TYPESAFE_API_KEY` **and** the agent has `settings.jev.enabled: true`. Best-effort throughout: no key, a timeout (2.5 s), an HTTP error or an unreadable answer leave the turn exactly as it would be without Jev. The nudge/follow-up paths do not use it.

`settings.jev` is read only by `readJevConfig`; it is not in the MCP settings schema nor in the agent editor. It is set straight in the agent's `settings` JSON, and unknown or invalid values fall back to the defaults below.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `latinOnly` | `false` | Strip letters of non-Latin scripts from the reply (a model leaking a Gujarati/CJK token into Portuguese). |
| `ackThreshold` | `0.9` | (0, 1]. At or above it, a short message (≤ 60 chars) that is only "ok/valeu/obrigado/emoji" ends the turn with a reaction and **no model call**. |
| `ackEmoji` | `👍` | The reaction. |
| `humanThreshold` | `0.9` | (0, 1]: at or above it the model is told "the customer ASKED FOR A PERSON: transfer now". **Any value above 1 (e.g. `2`) turns that note off**, for an agent with nobody to hand to. |
| `intents` | `{}` | `name: description` (at least two) the reading picks from; the model gets the likely intent. |
| `outputCheck.enabled` | `false` | Needs `instructions` too. |
| `outputCheck.instructions` | `""` | The rules a reply must not break, in plain words. |
| `outputCheck.threshold` | `0.9` | (0, 1]. At or above it the reply is held. |
| `outputCheck.onBreak` | `"handoff"` | What a held reply does: `"handoff"` or `"retry"` (below). |
| `outputCheck.handoffMessage` | "Deixa eu confirmar isso com a equipe…" | `handoff` only: the line the customer reads. |
| `outputCheck.retryFallback` | "Não consegui concluir isso agora. Pode me mandar de novo o que precisa registrar?" | `retry` only: sent when the retry also breaks the rules. |

## The acknowledgement shortcut never answers a question

"Sim", "250", "Outubro" or "Pix" sent in reply to a question **is** the conversation, and reading it as a thank-you leaves it hanging. So before the reading the turn fetches the conversation page from Chatwoot (what was actually delivered: split balloons and templates included) and takes **our side's last public message** (`lastAgentMessage`: newest `outgoing`/`template`, not private, not a reaction, with text):

- **Deterministic guard:** if that message contains `?` (or `¿`), `isBareAcknowledgement` is false whatever Jev says, and the model runs.
- **Context for Jev:** the message (cut at 600 chars) goes in the `state` as "Última mensagem do atendente", and the `ack` question says an answer to a question or to a request for information/decision is not a confirmation.
- No history, or a page that cannot be read: the reading runs as it did before.

The `jev` flow line of the reading carries `agentAsked`.

## outputCheck: `handoff` vs `retry`

`handoff` (default, unchanged): the reply and anything the model queued (attachments, buttons, carousel) are dropped, the conversation goes to the team (`handOverForGuardrail("output")`) and the customer reads `handoffMessage`.

`retry` is for an agent with no team behind it (e.g. an assistant whose only user is the business owner). Nobody is called:

1. Inside the invoke, a final answer with text is checked (`checkReply`, `src/graph/graph.ts`). If it breaks the rules it is **neither sent nor persisted**, and the model is asked again in the same round with a late system note (`JEV_RETRY_MARK`): the rule, a 300-char summary of the held reply, and the two ways out — call the tool it skipped instead of promising, or say clearly what was not done. Once per turn. The retry spends the same turn: same tool budget (`maxToolCalls` counts since the customer's message), same job deadline and model semaphore, and it is skipped once the run is called off or a transfer completed.
   In this mode the rule check is also told **which tools the model called this turn** ("Ferramentas que o atendente chamou neste turno: …" or "nenhuma"), so a rule like "says it registered something without calling the tool" can be judged; Jev otherwise sees only the reply. The `handoff` mode asks exactly what it asked before.
2. Whatever the turn ends on goes through the normal check before delivery (one Jev call per distinct text: the verdict from step 1 is reused). Still breaking: the queued items are dropped, the held words are rolled out of the thread (so the next turn does not read them as said), and `retryFallback` is sent. No transfer.

Flow lines (`stage: "jev"`): `{ outputCheck, held, retried: true }` when the draft is held and retried; at delivery `{ outputCheck, held, retried }` (`retried` only in `retry` mode).

A reply the model wrote beside a tool call and that the turn recovers at the end (issue #886) is not seen by step 1; if it breaks the rules it goes straight to `retryFallback`.

## Example (an assistant with no human behind it)

```json
{
  "jev": {
    "enabled": true,
    "humanThreshold": 2,
    "outputCheck": {
      "enabled": true,
      "instructions": "diz que registrou, salvou, agendou ou enviou algo sem ter chamado a ferramenta que faz isso",
      "onBreak": "retry",
      "retryFallback": "Não consegui concluir isso agora. Pode me mandar de novo o que precisa registrar?"
    }
  }
}
```
