import type {
  RyzeContact,
  RyzeConversation,
  RyzeGateway,
  RyzeMessage,
} from "@/../generated/prisma/client";
import { RYZE_CHANNEL_TYPE, RYZE_PROVIDER } from "./constants";

// Pure presenters: our rows in the exact shapes the Chatwoot client and the Agent Bot receiver read.
// REST pages carry message_type as Chatwoot's integer; webhook bodies carry it as the string, which
// is also what Chatwoot does (normalize.ts reads both).

const MESSAGE_TYPE_NAMES = ["incoming", "outgoing", "activity", "template"];

export interface StoredAttachment {
  id: number;
  file_type: string;
  data_url: string;
  file_name?: string | null;
  meta?: Record<string, unknown>;
  coordinates_lat?: number | null;
  coordinates_long?: number | null;
  fallback_title?: string | null;
}

function epochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function epochFloat(d: Date): number {
  return d.getTime() / 1000;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function storedAttachments(m: RyzeMessage): StoredAttachment[] {
  return Array.isArray(m.attachments)
    ? (m.attachments as unknown as StoredAttachment[])
    : [];
}

function sender(m: RyzeMessage): Record<string, unknown> | null {
  if (!m.senderType) return null;
  return {
    id: m.senderId,
    name: m.senderName,
    type: m.senderType,
  };
}

export function presentMessageRest(m: RyzeMessage): Record<string, unknown> {
  return {
    id: m.messageId,
    content: m.content,
    message_type: m.messageType,
    private: m.private,
    created_at: epochSeconds(m.createdAt),
    conversation_id: m.conversationId,
    status: m.status,
    source_id: m.externalId,
    content_attributes: record(m.contentAttributes),
    sender: sender(m),
    attachments: storedAttachments(m).map((a) => ({
      id: a.id,
      file_type: a.file_type,
      data_url: a.data_url,
      meta: a.meta ?? {},
      coordinates_lat: a.coordinates_lat ?? null,
      coordinates_long: a.coordinates_long ?? null,
      fallback_title: a.fallback_title ?? null,
    })),
  };
}

export function presentContact(c: RyzeContact): Record<string, unknown> {
  return {
    id: c.contactId,
    name: c.name ?? "",
    email: c.email,
    phone_number: c.phone,
    identifier: c.identifier,
    custom_attributes: record(c.customAttributes),
  };
}

function assigneeMeta(conv: RyzeConversation): Record<string, unknown> | null {
  return conv.assigneeType && conv.assigneeId !== null
    ? { id: conv.assigneeId, name: conv.assigneeName ?? "" }
    : null;
}

export function presentConversation(
  conv: RyzeConversation,
  contact: RyzeContact | null,
  gateway: Pick<RyzeGateway, "inboxId">,
  lastMessageId: number | null,
): Record<string, unknown> {
  return {
    id: conv.displayId,
    inbox_id: gateway.inboxId,
    status: conv.status,
    can_reply: true,
    channel: RYZE_CHANNEL_TYPE,
    contact_inbox: { id: conv.contactInboxId, source_id: conv.chatJid },
    contact_inbox_id: conv.contactInboxId,
    meta: {
      sender: contact ? presentContact(contact) : null,
      assignee_type: conv.assigneeType,
      assignee: assigneeMeta(conv),
      team: conv.teamId !== null ? { id: conv.teamId } : null,
      channel: RYZE_CHANNEL_TYPE,
    },
    labels: conv.labels,
    custom_attributes: record(conv.customAttributes),
    kanban_task: null,
    last_activity_at: epochSeconds(conv.lastActivityAt),
    timestamp: epochSeconds(conv.lastActivityAt),
    updated_at: epochFloat(conv.updatedAt),
    created_at: epochSeconds(conv.createdAt),
    first_reply_created_at: null,
    messages: lastMessageId !== null ? [{ id: lastMessageId }] : [],
    last_non_activity_message:
      lastMessageId !== null ? { id: lastMessageId } : null,
  };
}

export function presentMessageWebhook(
  event: "message_created" | "message_updated",
  m: RyzeMessage,
  conversation: Record<string, unknown>,
  gateway: Pick<RyzeGateway, "inboxId" | "inboxName">,
): Record<string, unknown> {
  const rest = presentMessageRest(m);
  return {
    ...rest,
    event,
    message_type: MESSAGE_TYPE_NAMES[m.messageType] ?? "incoming",
    created_at: new Date(m.createdAt).toISOString(),
    attachments: storedAttachments(m).map((a) => ({
      id: a.id,
      file_type: a.file_type,
      data_url: a.data_url,
      transcribed_text: record(a.meta).transcribed_text ?? "",
      meta: a.meta ?? {},
      coordinates_lat: a.coordinates_lat ?? null,
      coordinates_long: a.coordinates_long ?? null,
      fallback_title: a.fallback_title ?? null,
    })),
    inbox: { id: gateway.inboxId, name: gateway.inboxName },
    conversation,
  };
}

export function presentInbox(
  gateway: Pick<RyzeGateway, "inboxId" | "inboxName">,
): Record<string, unknown> {
  return {
    id: gateway.inboxId,
    name: gateway.inboxName,
    channel_type: RYZE_CHANNEL_TYPE,
    provider: RYZE_PROVIDER,
    working_hours_enabled: false,
    out_of_office_message: null,
    message_templates: [],
  };
}
