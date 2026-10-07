# RyzeAPI channel

RyzeAPI (a whatsmeow-based WhatsApp REST gateway) is a second channel beside Chatwoot. A tenant can have Chatwoot accounts, RyzeAPI numbers, or both.

## Shape: an emulated Chatwoot

The runtime talks to Chatwoot everywhere: the receiver, the mirror, the gates, debounce, the turn, follow-ups, takeover and the native tools all hold a `ChatwootClient` and re-read messages through it (there is no message table of our own). So RyzeAPI is not added as a new transport through all of them. A number is an account (`ChatwootInstance`) of `kind: RYZE`, and `loadChatwootClient` builds its `ChatwootClient` over `RyzeEmulator.fetch` (`src/modules/ryze/emulator.ts`), an in-process implementation of the Chatwoot API over our own tables:

| Table | What it holds |
|---|---|
| `ryze_gateways` | the RyzeAPI instance (base URL, name, encrypted token), the webhook route token hash and Authorization value, the emulated inbox id, the attached bot and observers, the last connection state |
| `ryze_bots` | emulated Agent Bots: outgoing URL, access token, HMAC secret |
| `ryze_contacts` / `ryze_conversations` | one contact and one conversation per WhatsApp chat |
| `ryze_messages` / `ryze_media` | the message rows the runtime re-reads, and the bytes behind attachment `data_url`s |

Every emulated id comes from `ryze_emulated_id_seq`, which starts at 1,500,000,000 so it never meets a real Chatwoot id in the same tenant. The emulator answers on `https://203.0.113.250/ryze-emulator/<instanceId>` (TEST-NET-3: never routed, passes the outbound guard without DNS, intercepted before any socket).

## Inbound

`POST /api/v1/ryze/webhook/:routeToken` (`src/modules/ryze/receiver.ts`). Ryze does not sign, so the route token resolves the gateway and the static `Authorization` value we set on the Ryze webhook authenticates the call. `message.exchange` in a private chat is stored and re-emitted to the inbox's bot (and observers) as the Chatwoot Agent Bot webhook it would have been: raw JSON, a delivery UUID, `sha256=HMAC(secret, "{ts}.{body}")`, dispatched in-process to the Chatwoot receiver (`src/modules/ryze/emit.ts`), in order per gateway.

| Ryze event | Emulated as |
|---|---|
| incoming message | `message_created` incoming (a resolved conversation is first reopened as pending and announced) |
| outgoing, `source` is ours | dropped: our own send echoing back |
| outgoing, no source, id or text of a send of ours in the last minute | dropped, and the gateway id is adopted onto our row |
| outgoing otherwise | `message_created` in the device-reply shape (`sender: null`, `external_sender_name: "WhatsApp"`), which is what triggers human takeover |
| `instance.state` | stored on the gateway |
| `label.update` | the catalog row refreshed or imported (`edit`), or the label moved on the conversation and recorded in `deviceLabels` (`chat`), never synced back; `message` ignored |

The inbox reports `provider: "ryze"`, which is in `ECHO_RESERVING_WHATSAPP_PROVIDERS`: the emulator records a send before RyzeAPI is called and drops our echoes, so an unsent outgoing event can only be a person on the phone.

## Outbound

Public outgoing messages go out through `/api/message/text` or `/api/message/media` with `source: "fazer-ai-agents"`; typing through `/api/chat/presence` (`state: "typing"`, or `"recording"` when the `toggle_typing_status` body carries `presence: "recording"`, and `"pause"` for off; `ryzePresenceOf` in the emulator); read receipts through `/api/chat/markRead`; reactions through `/api/message/reaction`. A send RyzeAPI refuses deletes the row and answers 422 (a 4xx from Ryze) or 503, so the delivery path's read-back finds nothing and treats it as not landed. Private notes, attributes, status and assignment live only in our tables and are announced to the bot like Chatwoot announces them; conversation labels also go to WhatsApp (below). There are no agents or teams to assign to; a handoff opens the conversation and the person answers from the phone.

### Sending as the agent over REST

`POST /v1/ryze/gateways/:id/messages` (`to`, `text`) and `POST /v1/ryze/gateways/:id/cards` (`to`, `text`, `header?`, `footer?`, `mediaUrl?`, `buttons[]`) let the operator's backend send into a contact's conversation as the agent (`src/modules/ryze/interactive.ts`). The row is stored as the agent's own message, so the model reads it and no human takeover is inferred. The contact and conversation are created when the contact never wrote, and a Brazilian mobile reuses the one stored with or without the ninth digit.

Both take four optional fields that open a conversation with context the agent reads when the contact answers:

| Field | Written as |
|---|---|
| `contactName` | the contact's name, only when it has none (the contact's own WhatsApp name replaces it when they write) |
| `contactAttributes` | merged into the contact's `custom_attributes` |
| `conversationAttributes` | merged into the conversation's `custom_attributes` |
| `labels` | added to the conversation's labels; none is ever removed |

- They go through the emulator's own routes (`PUT /contacts/:id`, `POST /conversations/:id/custom_attributes`, `POST /conversations/:id/labels`), after the contact and conversation are committed and before the message row is staged. Those routes replace what they are given, so each gets the stored bag or set with the new keys merged in, as `ChatwootClient` does. The conversation writes announce `conversation_updated` to the bots, and labels follow the WhatsApp Business sync below (persisted first, synced in the gateway's queue, never failing the write).
- Limits: at most 50 attributes per bag, keys `A-Z a-z 0-9 _ -` up to 64, values a string up to 1000 characters, a number or a boolean; at most 10 labels, each in the slug form catalog titles use (`a-z 0-9 _ -`, up to 40). A refused field answers 400 (422 when the body schema refuses it) before anything is written or sent.
- A context write that fails answers 500 and sends nothing; what was already written stays. A send that fails after the context was written leaves the context in place (only the message row is removed).
- The agent sees these values through the attribute context (`docs/chatwoot.md`, "Attribute context"): every payload of the conversation carries both bags, but only the keys selected in the agent's "Data in context" reach the prompt.
- A body without these fields (or with them empty) behaves exactly as before: one transaction stages the contact, conversation and message.

## WhatsApp Business labels

A number's labels are a catalog of its own, `ryze_labels` (`src/modules/ryze/labels.ts`, pure half in `label-shared.ts`): `title` is what the conversation rows and the model use, `displayName` the name on WhatsApp (`tagId`), `description` the "when to use" the prompt shows, `autoRule` an optional automatic rule. WhatsApp Business allows 20 labels per number, and the 21st is refused. Console: Channels → a Ryze number → WhatsApp labels; REST `GET/POST /v1/ryze/gateways/:id/labels`, `PATCH/DELETE /v1/ryze/gateways/:id/labels/:labelId`.

- Listing pulls `GET /api/chat/tag` in: a tag we hold by id is refreshed, one matching a row by name lends it its id, anything else is imported with origin `device` and the slug of its name as title.
- A conversation's label write (`set_labels`, follow-up `assignLabels`, anything through the emulator) is persisted first, then synced in a per-gateway queue: an added title gets a catalog row (auto-created, color 0, while there is room) and a WhatsApp tag, then `assignTag`; a removed one is unassigned. The sync never fails the write.
- A number that refuses label calls (not WhatsApp Business) is flagged `labelsSupported = false`; label calls are then skipped and asked again at most every 6 hours. The labels keep working inside fazer.ai.
- Titles the team moves on the phone go into `ryze_conversations.device_labels`, which only grows: for the rest of the conversation `set_labels` treats them as protected labels. Automatic writes may still move them.
- Rules: `clear_on_reply` comes off when the contact writes; `human_takeover` goes on when the conversation is opened (takeover, handoff) and off when it is set back to pending or reopened by the contact; `new_conversation` goes on the first conversation of a chat, unless the chat's first message is older than the gateway's `connectedAt` (set when a number pairs: at connect if already up, on the first `connected` state otherwise, and again when another number takes the instance; gateways that had their number before the column keep null and the old rule). RyzeAPI has no chat listing, so a chat that existed on the phone but whose first message reaches us after the connection still counts as new: give or take the label by hand.
- The prompt of a Ryze conversation carries a block listing the labels that have a "when to use", the one-stage-at-a-time rule for descriptions starting with `Etapa:`, and the phone-edited titles.
- A lid or group chat has no phone number to tag, so its labels stay local. A number connected before `label.update` was subscribed does not receive phone edits until its RyzeAPI webhook also lists that event (our route token is stored only as a hash, so the URL has to come from RyzeAPI's own webhook config).

### The reply gate

An agent with `settings.replyGate` on speaks only in a conversation carrying its required label, which here must be
in the number's live catalog and synced to WhatsApp (a `tagId`); anything else holds the reply. A move to `open`
(any hand-off) takes the required label off and puts the hand-off label on when the catalog has it, through the
ordinary label sync. The emulator also refuses an agent bot's send on a gated conversation (422
`reply_gate_closed`) as a backstop. Off by default. See [`LIVARE-F21-PORTAO-ETIQUETA.md`](LIVARE-F21-PORTAO-ETIQUETA.md).

## Not supported on RyzeAPI

Kanban, cross-inbox cases, contact merge, website-chat redirect, WhatsApp templates (RyzeAPI is not the official API, so there is no 24h window and follow-ups go out as plain text). Routes for these answer 404 from the emulator.

## Operating

- Console: Channels → WhatsApp via RyzeAPI → Connect number. One modal in three steps: instance name and token (the URL defaults to https://ryzeapi.cloud), pairing by QR code or by phone code (`POST /v1/ryze/gateways/:id/pair`, re-asked every 25s while the status is polled every 3s), and the agent that answers (the same inbox bind the Chatwoot inboxes use). `src/client/pages/channels/RyzeSection.tsx`.
- Connect: `POST /v1/ryze/gateways` or the MCP tool `ryze_connect` (then `inbox_bind` the new inbox to an agent). Validates the token, registers our webhook on the instance (`events: message.exchange, instance.state, label.update`, `mediaBase64: true`), creates the inbox mirror.
- List / refresh / remove: `ryze_list`, `ryze_refresh`, `ryze_remove` (and the REST routes beside them).
- A tenant with no Chatwoot gets a placeholder deployment row (base URL `https://203.0.113.250/ryze-emulator`); disconnecting Chatwoot is refused while RyzeAPI numbers exist, because its cascade would take them.

An incoming attachment's kind (`file_type`, which decides whether STT runs) comes from its MIME, read from `media.mimetype`, `mimeType` or `mime`: `audio/*`, `image/*`, `video/*`, anything else a file. `media.type` decides only when the MIME is missing or `application/octet-stream`, because the live gateway sends values outside `image | sticker | audio | ptt | video | ptv | document` (a voice note with `audio/mpeg` was stored as a file and never transcribed). `inboundMedia` in `receiver.ts`.
