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

## WhatsApp Business labels

A number's labels are a catalog of its own, `ryze_labels` (`src/modules/ryze/labels.ts`, pure half in `label-shared.ts`): `title` is what the conversation rows and the model use, `displayName` the name on WhatsApp (`tagId`), `description` the "when to use" the prompt shows, `autoRule` an optional automatic rule. WhatsApp Business allows 20 labels per number, and the 21st is refused. Console: Channels → a Ryze number → WhatsApp labels; REST `GET/POST /v1/ryze/gateways/:id/labels`, `PATCH/DELETE /v1/ryze/gateways/:id/labels/:labelId`.

- Listing pulls `GET /api/chat/tag` in: a tag we hold by id is refreshed, one matching a row by name lends it its id, anything else is imported with origin `device` and the slug of its name as title.
- A conversation's label write (`set_labels`, follow-up `assignLabels`, anything through the emulator) is persisted first, then synced in a per-gateway queue: an added title gets a catalog row (auto-created, color 0, while there is room) and a WhatsApp tag, then `assignTag`; a removed one is unassigned. The sync never fails the write.
- A number that refuses label calls (not WhatsApp Business) is flagged `labelsSupported = false`; label calls are then skipped and asked again at most every 6 hours. The labels keep working inside fazer.ai.
- Titles the team moves on the phone go into `ryze_conversations.device_labels`, which only grows: for the rest of the conversation `set_labels` treats them as protected labels. Automatic writes may still move them.
- Rules: `clear_on_reply` comes off when the contact writes; `human_takeover` goes on when the conversation is opened (takeover, handoff) and off when it is set back to pending or reopened by the contact; `new_conversation` goes on the first conversation of a chat.
- The prompt of a Ryze conversation carries a block listing the labels that have a "when to use", the one-stage-at-a-time rule for descriptions starting with `Etapa:`, and the phone-edited titles.
- A lid or group chat has no phone number to tag, so its labels stay local. A number connected before `label.update` was subscribed does not receive phone edits until its RyzeAPI webhook also lists that event (our route token is stored only as a hash, so the URL has to come from RyzeAPI's own webhook config).

## Not supported on RyzeAPI

Kanban, cross-inbox cases, contact merge, website-chat redirect, WhatsApp templates (RyzeAPI is not the official API, so there is no 24h window and follow-ups go out as plain text). Routes for these answer 404 from the emulator.

## Operating

- Console: Channels → WhatsApp via RyzeAPI → Connect number. One modal in three steps: instance name and token (the URL defaults to https://ryzeapi.cloud), pairing by QR code or by phone code (`POST /v1/ryze/gateways/:id/pair`, re-asked every 25s while the status is polled every 3s), and the agent that answers (the same inbox bind the Chatwoot inboxes use). `src/client/pages/channels/RyzeSection.tsx`.
- Connect: `POST /v1/ryze/gateways` or the MCP tool `ryze_connect` (then `inbox_bind` the new inbox to an agent). Validates the token, registers our webhook on the instance (`events: message.exchange, instance.state, label.update`, `mediaBase64: true`), creates the inbox mirror.
- List / refresh / remove: `ryze_list`, `ryze_refresh`, `ryze_remove` (and the REST routes beside them).
- A tenant with no Chatwoot gets a placeholder deployment row (base URL `https://203.0.113.250/ryze-emulator`); disconnecting Chatwoot is refused while RyzeAPI numbers exist, because its cascade would take them.

An incoming attachment's kind (`file_type`, which decides whether STT runs) comes from its MIME, read from `media.mimetype`, `mimeType` or `mime`: `audio/*`, `image/*`, `video/*`, anything else a file. `media.type` decides only when the MIME is missing or `application/octet-stream`, because the live gateway sends values outside `image | sticker | audio | ptt | video | ptv | document` (a voice note with `audio/mpeg` was stored as a file and never transcribed). `inboundMedia` in `receiver.ts`.
