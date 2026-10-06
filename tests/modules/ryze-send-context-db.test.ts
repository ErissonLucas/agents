import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { RyzeClient } from "@/modules/ryze/client";
import { RYZE_EMULATED_ACCOUNT_ID } from "@/modules/ryze/constants";
import { drainEmits } from "@/modules/ryze/emit";
import { RyzeEmulator, setRyzeClientFactory } from "@/modules/ryze/emulator";
import { sendRyzeCard, sendRyzeText } from "@/modules/ryze/interactive";
import { drainLabelSyncs } from "@/modules/ryze/labels";
import { connectRyzeGateway } from "@/modules/ryze/service";
import { outboundUrl } from "../utils/outbound";

// A send as the agent that carries conversation context against the database: the contact's name,
// both attribute bags and added labels are written through the emulator before the message, read
// back the way the runtime reads them, merged into what is there, and a send without them is the
// send it always was.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

// A RyzeAPI instance that accepts sends and labels; `failSends` refuses the message itself.
class FakeRyze {
  tags: { id: string; name: string }[] = [];
  assigned = new Set<string>();
  sent: { path: string; body: Record<string, unknown> }[] = [];
  failSends = false;
  private next = 1;

  client(): RyzeClient {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const path = url.pathname;
      if (path.startsWith("/api/chat/tag")) {
        if (method === "GET")
          return Response.json({ success: true, tags: this.tags });
        const tag = { id: String(this.next++), name: String(body.name) };
        this.tags.push(tag);
        return Response.json({ success: true, tag: { ...tag, color: 0 } });
      }
      if (path.startsWith("/api/chat/assignTag")) {
        this.assigned.add(`${String(body.number)}:${String(body.tagId)}`);
        return Response.json({ success: true });
      }
      if (path.startsWith("/api/message/")) {
        if (this.failSends)
          return new Response(
            JSON.stringify({ error: { message: "number not on WhatsApp" } }),
            { status: 400 },
          );
        this.sent.push({ path, body });
      }
      if (path.startsWith("/api/instance/list")) {
        return Response.json({
          success: true,
          instances: [
            {
              name: "livare",
              connection: { state: "connected", numberJid: "5581900000000" },
            },
          ],
        });
      }
      return Response.json({
        success: true,
        data: { messageId: `OUT${this.next++}` },
      });
    }) as typeof fetch;
    return new RyzeClient(
      { baseUrl: outboundUrl("/"), instance: "livare", token: "tok" },
      fetchImpl,
    );
  }
}

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("RyzeAPI send with conversation context", () => {
  const ryze = new FakeRyze();
  const deps = () => ({
    base: appDb,
    makeClient: async () => ryze.client(),
  });
  let instanceId = 0n;
  let gatewayId = 0n;
  let restoreFactory: ReturnType<typeof setRyzeClientFactory>;

  async function emulated(path: string): Promise<Record<string, unknown>> {
    const emulator = new RyzeEmulator(tenantId, instanceId, { base: appDb });
    const res = await emulator.fetch(
      `${emulator.baseUrl}/api/v1/accounts/${RYZE_EMULATED_ACCOUNT_ID}${path}`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function conversation(displayId: number) {
    return emulated(`/conversations/${displayId}`);
  }

  async function messages(displayId: number) {
    return runScopedOn(appDb, ctx(), (db) =>
      db.ryzeMessage.findMany({
        where: { gatewayId, conversationId: displayId },
        orderBy: { messageId: "asc" },
      }),
    );
  }

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RYZE CONTEXT", slug: `ryze-context-${process.pid}` },
    });
    tenantId = t.id;
    restoreFactory = setRyzeClientFactory(async () => ryze.client());
    const view = await connectRyzeGateway(
      ctx(),
      {
        name: "Livare",
        baseUrl: outboundUrl("/"),
        instanceName: "livare",
        token: "tok",
      },
      { makeRyzeClient: async () => ryze.client() },
      appDb,
    );
    instanceId = BigInt(view.instanceId);
    gatewayId = (
      await runScopedOn(appDb, ctx(), (db) =>
        db.ryzeGateway.findUniqueOrThrow({
          where: { chatwootInstanceId: instanceId },
        }),
      )
    ).id;
  });

  afterAll(async () => {
    setRyzeClientFactory(restoreFactory);
    if (tenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a send without the new fields creates the conversation bare, as before", async () => {
    const sent = await sendRyzeText(
      ctx(),
      instanceId,
      { to: "5581977770001", text: "Olá" },
      deps(),
    );
    const body = await conversation(sent.conversationId);
    expect(body.labels).toEqual([]);
    expect(body.custom_attributes).toEqual({});
    const sender = (body.meta as Record<string, Record<string, unknown>>)
      .sender;
    expect(sender?.name).toBe("");
    expect(sender?.custom_attributes).toEqual({});
    const rows = await messages(sent.conversationId);
    expect(rows.map((r) => [r.content, r.status])).toEqual([["Olá", "sent"]]);
  });

  test("a first send to a contact who never wrote carries its context into the conversation", async () => {
    const sent = await sendRyzeCard(
      ctx(),
      instanceId,
      {
        to: "5581977770002",
        text: "Oi, Ana! Recebemos seu interesse no Atacama.",
        buttons: [{ id: "livare:quero", title: "Quero saber mais" }],
        contactName: "Ana Souza",
        contactAttributes: { origem: "meta-form", orcamento: 15000 },
        conversationAttributes: {
          deal_id: 4242,
          produto: "acpb",
          vendedor: "Maiara",
          link_negocio: "https://livare.pipedrive.com/deal/4242",
          tem_passaporte: true,
        },
        labels: ["novo-lead", "acpb"],
      },
      deps(),
    );
    await drainLabelSyncs(gatewayId);
    await drainEmits(gatewayId);

    const body = await conversation(sent.conversationId);
    expect(body.custom_attributes).toEqual({
      deal_id: 4242,
      produto: "acpb",
      vendedor: "Maiara",
      link_negocio: "https://livare.pipedrive.com/deal/4242",
      tem_passaporte: true,
    });
    expect(body.labels).toEqual(["novo-lead", "acpb"]);
    const sender = (body.meta as Record<string, Record<string, unknown>>)
      .sender;
    expect(sender?.name).toBe("Ana Souza");
    expect(sender?.custom_attributes).toEqual({
      origem: "meta-form",
      orcamento: 15000,
    });

    const contact = await emulated(`/contacts/${String(sender?.id)}`);
    expect(
      (contact.payload as Record<string, unknown>).custom_attributes,
    ).toEqual({ origem: "meta-form", orcamento: 15000 });

    const rows = await messages(sent.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.senderType).not.toBe("contact");

    for (const title of ["novo-lead", "acpb"]) {
      const tag = ryze.tags.find((t) => t.name === title);
      expect(tag).toBeDefined();
      expect(ryze.assigned.has(`5581977770002:${tag?.id}`)).toBe(true);
    }
  });

  test("a later send merges attributes and adds labels without taking any off", async () => {
    const first = await sendRyzeText(
      ctx(),
      instanceId,
      {
        to: "5581977770003",
        text: "Primeira",
        contactName: "Bruno",
        contactAttributes: { origem: "site", cidade: "Recife" },
        conversationAttributes: { deal_id: 1, produto: "patagonia" },
        labels: ["novo-lead"],
      },
      deps(),
    );
    const emulator = new RyzeEmulator(tenantId, instanceId, { base: appDb });
    await emulator.fetch(
      `${emulator.baseUrl}/api/v1/accounts/${RYZE_EMULATED_ACCOUNT_ID}/conversations/${first.conversationId}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ labels: ["novo-lead", "cliente-vip"] }),
      },
    );

    const second = await sendRyzeText(
      ctx(),
      instanceId,
      {
        to: "5581977770003",
        text: "Segunda",
        contactName: "Outro Nome",
        contactAttributes: { origem: "live" },
        conversationAttributes: { produto: "acpb", vendedor: "Vitor" },
        labels: ["novo-lead", "acpb"],
      },
      deps(),
    );
    expect(second.conversationId).toBe(first.conversationId);
    await drainLabelSyncs(gatewayId);

    const body = await conversation(second.conversationId);
    expect(body.custom_attributes).toEqual({
      deal_id: 1,
      produto: "acpb",
      vendedor: "Vitor",
    });
    expect(body.labels).toEqual(["novo-lead", "cliente-vip", "acpb"]);
    const sender = (body.meta as Record<string, Record<string, unknown>>)
      .sender;
    expect(sender?.name).toBe("Bruno");
    expect(sender?.custom_attributes).toEqual({
      origem: "live",
      cidade: "Recife",
    });
    const rows = await messages(second.conversationId);
    expect(rows.map((r) => r.content)).toEqual(["Primeira", "Segunda"]);
  });

  test("the long form of a Brazilian mobile lands its context on the conversation stored short", async () => {
    const short = await sendRyzeText(
      ctx(),
      instanceId,
      { to: "558177770004", text: "Curto" },
      deps(),
    );
    const long = await sendRyzeText(
      ctx(),
      instanceId,
      {
        to: "5581977770004",
        text: "Longo",
        conversationAttributes: { deal_id: 77 },
        labels: ["novo-lead"],
      },
      deps(),
    );
    expect(long.conversationId).toBe(short.conversationId);
    const body = await conversation(short.conversationId);
    expect(body.custom_attributes).toEqual({ deal_id: 77 });
    expect(body.labels).toEqual(["novo-lead"]);
  });

  test("a send RyzeAPI refuses keeps the context written and removes the message row", async () => {
    ryze.failSends = true;
    try {
      await expect(
        sendRyzeText(
          ctx(),
          instanceId,
          {
            to: "5581977770005",
            text: "Não vai",
            conversationAttributes: { deal_id: 5 },
          },
          deps(),
        ),
      ).rejects.toThrow();
    } finally {
      ryze.failSends = false;
    }
    const conv = await runScopedOn(appDb, ctx(), (db) =>
      db.ryzeConversation.findUniqueOrThrow({
        where: {
          gatewayId_chatJid: {
            gatewayId,
            chatJid: "5581977770005@s.whatsapp.net",
          },
        },
      }),
    );
    expect(conv.customAttributes).toEqual({ deal_id: 5 });
    expect(await messages(conv.displayId)).toEqual([]);
  });
});
