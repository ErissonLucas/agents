import type {
  Prisma,
  PrismaClient,
  RyzeContact,
  RyzeConversation,
  RyzeGateway,
  RyzeMessage,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { presentConversation } from "./present";

// The emulator's state, read and written only inside the tenant's scoped transaction. Every lookup
// is keyed on the gateway, so two Ryze accounts of one tenant never see each other's rows.

export const PAGE_SIZE = 20;
export const AFTER_PAGE_SIZE = 100;

export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function scoped<T>(
  tenantId: bigint,
  fn: (db: ScopedDb) => Promise<T>,
  base: PrismaClient = basePrisma,
): Promise<T> {
  return runScopedOn(base, sysCtx(tenantId), fn);
}

export async function gatewayForInstance(
  db: ScopedDb,
  instanceId: bigint,
): Promise<RyzeGateway | null> {
  return db.ryzeGateway.findUnique({
    where: { chatwootInstanceId: instanceId },
  });
}

export async function conversationByDisplayId(
  db: ScopedDb,
  gatewayId: bigint,
  displayId: number,
): Promise<RyzeConversation | null> {
  const conv = await db.ryzeConversation.findUnique({ where: { displayId } });
  return conv && conv.gatewayId === gatewayId ? conv : null;
}

export async function contactById(
  db: ScopedDb,
  gatewayId: bigint,
  contactId: number,
): Promise<RyzeContact | null> {
  const c = await db.ryzeContact.findUnique({ where: { contactId } });
  return c && c.gatewayId === gatewayId ? c : null;
}

export async function latestMessageId(
  db: ScopedDb,
  gatewayId: bigint,
  conversationId: number,
): Promise<number | null> {
  const m = await db.ryzeMessage.findFirst({
    where: { gatewayId, conversationId, messageType: { not: 2 } },
    orderBy: { messageId: "desc" },
    select: { messageId: true },
  });
  return m?.messageId ?? null;
}

export async function conversationBody(
  db: ScopedDb,
  gateway: RyzeGateway,
  conv: RyzeConversation,
): Promise<Record<string, unknown>> {
  const contact = await contactById(db, gateway.id, conv.contactId);
  const last = await latestMessageId(db, gateway.id, conv.displayId);
  return presentConversation(conv, contact, gateway, last);
}

export async function listMessages(
  db: ScopedDb,
  gatewayId: bigint,
  conversationId: number,
  q: { before?: number; after?: number },
): Promise<RyzeMessage[]> {
  if (q.after !== undefined) {
    return db.ryzeMessage.findMany({
      where: { gatewayId, conversationId, messageId: { gt: q.after } },
      orderBy: { messageId: "asc" },
      take: AFTER_PAGE_SIZE,
    });
  }
  const page = await db.ryzeMessage.findMany({
    where: {
      gatewayId,
      conversationId,
      ...(q.before !== undefined ? { messageId: { lt: q.before } } : {}),
    },
    orderBy: { messageId: "desc" },
    take: PAGE_SIZE,
  });
  return page.reverse();
}

// A Brazilian mobile exists on WhatsApp with or without the ninth digit (55 81 9xxxx-xxxx vs
// 55 81 xxxx-xxxx): an older account keeps the short form, and a send addressed to the long one reaches
// it. The other spelling of the same number, or null when there is none.
export function brazilianNinthDigitVariant(jid: string): string | null {
  const [user, domain] = jid.split("@");
  const m = /^55(\d{2})(\d{8,9})$/.exec(user ?? "");
  if (!m || !domain) return null;
  const [, ddd, local] = m as unknown as [string, string, string];
  if (local.length === 9 && local.startsWith("9"))
    return `55${ddd}${local.slice(1)}@${domain}`;
  if (local.length === 8 && "6789".includes(local[0] ?? ""))
    return `55${ddd}9${local}@${domain}`;
  return null;
}

export async function upsertContact(
  db: ScopedDb,
  gateway: RyzeGateway,
  jid: string,
  name: string | null,
): Promise<RyzeContact> {
  // The same person under the other spelling keeps one contact and one conversation.
  const variant = brazilianNinthDigitVariant(jid);
  if (variant) {
    const known = await db.ryzeContact.findUnique({
      where: { gatewayId_jid: { gatewayId: gateway.id, jid: variant } },
    });
    if (known) {
      return name && name !== known.name
        ? db.ryzeContact.update({ where: { id: known.id }, data: { name } })
        : known;
    }
  }
  const phone = /^\d+$/.test(jid.split("@")[0] ?? "")
    ? `+${jid.split("@")[0]}`
    : null;
  return db.ryzeContact.upsert({
    where: { gatewayId_jid: { gatewayId: gateway.id, jid } },
    create: {
      tenantId: gateway.tenantId,
      gatewayId: gateway.id,
      jid,
      name,
      phone,
    },
    update: name ? { name } : {},
  });
}

// The chat's single conversation. A resolved one is reopened as pending (the bot answers again);
// `reopened` tells the caller to announce the status change before the message.
export async function openConversation(
  db: ScopedDb,
  gateway: RyzeGateway,
  contact: RyzeContact,
): Promise<{ conv: RyzeConversation; created: boolean; reopened: boolean }> {
  const existing = await db.ryzeConversation.findUnique({
    where: {
      gatewayId_chatJid: { gatewayId: gateway.id, chatJid: contact.jid },
    },
  });
  if (!existing) {
    const conv = await db.ryzeConversation.create({
      data: {
        tenantId: gateway.tenantId,
        gatewayId: gateway.id,
        contactId: contact.contactId,
        chatJid: contact.jid,
        status: "pending",
      },
    });
    return { conv, created: true, reopened: false };
  }
  if (existing.status === "resolved") {
    const conv = await db.ryzeConversation.update({
      where: { id: existing.id },
      data: {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
        assigneeName: null,
      },
    });
    return { conv, created: false, reopened: true };
  }
  return { conv: existing, created: false, reopened: false };
}

export async function touchConversation(
  db: ScopedDb,
  conv: RyzeConversation,
  data: Prisma.RyzeConversationUpdateInput = {},
): Promise<RyzeConversation> {
  return db.ryzeConversation.update({
    where: { id: conv.id },
    data: { ...data, lastActivityAt: new Date() },
  });
}
