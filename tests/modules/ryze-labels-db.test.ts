import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { RyzeClient } from "@/modules/ryze/client";
import { drainEmits } from "@/modules/ryze/emit";
import { setRyzeClientFactory } from "@/modules/ryze/emulator";
import {
  createRyzeLabel,
  deleteRyzeLabel,
  drainLabelSyncs,
  listRyzeLabels,
  ryzeLabelTurnContext,
  updateRyzeLabel,
} from "@/modules/ryze/labels";
import { receiveRyzeWebhook } from "@/modules/ryze/receiver";
import { connectRyzeGateway } from "@/modules/ryze/service";
import { outboundUrl } from "../utils/outbound";

// WhatsApp Business labels on a RyzeAPI number against the database: the catalog and its import
// from the phone, a conversation's labels reaching WhatsApp, the team labelling on the phone coming
// back without being synced back, the automatic rules, and a number that refuses labels.

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

interface Tag {
  id: string;
  name: string;
  color: number;
  deleted: boolean;
}

// A RyzeAPI instance with a label store; `refuse` answers every label call like a number that is
// not WhatsApp Business.
class FakeRyze {
  tags: Tag[] = [];
  assigned = new Set<string>();
  calls: string[] = [];
  refuse = false;
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
      if (path.startsWith("/api/chat/")) {
        this.calls.push(`${method} ${path}${url.search}`);
        if (this.refuse) {
          return new Response(
            JSON.stringify({ error: { message: "not a business account" } }),
            { status: 400 },
          );
        }
      }
      if (path.startsWith("/api/chat/tag")) {
        if (method === "GET") {
          return Response.json({ success: true, tags: this.tags });
        }
        if (method === "POST") {
          const tag = {
            id: String(this.next++),
            name: String(body.name),
            color: Number(body.color ?? 0),
            deleted: false,
          };
          this.tags.push(tag);
          return Response.json({ success: true, tag });
        }
        const id = url.searchParams.get("tagId");
        const found = this.tags.find((t) => t.id === id && !t.deleted);
        if (!found) {
          return new Response(
            JSON.stringify({ error: { message: "Tag not found" } }),
            { status: 404 },
          );
        }
        found.deleted = true;
        return Response.json({ success: true });
      }
      if (path.startsWith("/api/chat/assignTag")) {
        const number =
          method === "POST"
            ? String(body.number)
            : String(url.searchParams.get("number"));
        const tagId =
          method === "POST"
            ? String(body.tagId)
            : String(url.searchParams.get("tagId"));
        if (!this.tags.some((t) => t.id === tagId && !t.deleted)) {
          return new Response(
            JSON.stringify({ error: { message: "Tag not found" } }),
            { status: 404 },
          );
        }
        if (method === "POST") this.assigned.add(`${number}:${tagId}`);
        else this.assigned.delete(`${number}:${tagId}`);
        return Response.json({ success: true });
      }
      if (path.startsWith("/api/instance/list")) {
        return Response.json({
          success: true,
          instances: [
            {
              name: "loja",
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
      { baseUrl: outboundUrl("/"), instance: "loja", token: "tok" },
      fetchImpl,
    );
  }

  tagNamed(name: string): Tag | undefined {
    return this.tags.find((t) => t.name === name && !t.deleted);
  }
}

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("RyzeAPI WhatsApp labels", () => {
  const ryze = new FakeRyze();
  const deps = () => ({
    base: appDb,
    makeRyzeClient: async () => ryze.client(),
  });
  let instanceId = 0n;
  let gatewayId = 0n;
  let auth = "";
  let routeToken = "";
  let conversationId = 0;
  const jid = "5581988887777";
  let restoreFactory: ReturnType<typeof setRyzeClientFactory>;

  async function hook(event: string, data: Record<string, unknown>) {
    return receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({ event, data }),
    });
  }

  async function inbound(id: string, text: string) {
    const res = await hook("message.exchange", {
      message: {
        id,
        direction: "incoming",
        chat: { jid, name: "Cliente", type: "private" },
        sender: { jid, name: "Cliente" },
        content: { text },
      },
    });
    await drainLabelSyncs(gatewayId);
    return res;
  }

  async function conv() {
    return runScopedOn(appDb, ctx(), (db) =>
      db.ryzeConversation.findFirstOrThrow({ where: { gatewayId } }),
    );
  }

  async function gateway() {
    return runScopedOn(appDb, ctx(), (db) =>
      db.ryzeGateway.findUniqueOrThrow({ where: { id: gatewayId } }),
    );
  }

  async function client() {
    return loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      botToken: "not-a-bot",
    });
  }

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RYZE LABELS", slug: `ryze-labels-${process.pid}` },
    });
    tenantId = t.id;
    restoreFactory = setRyzeClientFactory(async () => ryze.client());
    const calls: Array<Record<string, unknown>> = [];
    const view = await connectRyzeGateway(
      ctx(),
      {
        name: "Loja",
        baseUrl: outboundUrl("/"),
        instanceName: "loja",
        token: "tok",
      },
      {
        makeRyzeClient: async () => {
          const c = ryze.client();
          const orig = c.configureWebhook.bind(c);
          c.configureWebhook = async (p) => {
            calls.push(p);
            await orig(p);
          };
          return c;
        },
      },
      appDb,
    );
    instanceId = BigInt(view.instanceId);
    routeToken = String(calls[0]?.url).split("/").pop() as string;
    auth = String(calls[0]?.authorization);
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

  test("listing imports the labels created on the phone as origin device", async () => {
    ryze.tags.push({
      id: "100",
      name: "Cliente VIP",
      color: 5,
      deleted: false,
    });
    const catalog = await listRyzeLabels(ctx(), instanceId, deps());
    expect(catalog.labelsSupported).toBe(true);
    expect(catalog.max).toBe(20);
    const vip = catalog.labels.find((l) => l.tagId === "100");
    expect(vip).toMatchObject({
      title: "cliente-vip",
      displayName: "Cliente VIP",
      color: 5,
      origin: "device",
    });
    const again = await listRyzeLabels(ctx(), instanceId, deps());
    expect(again.labels.filter((l) => l.tagId === "100")).toHaveLength(1);
  });

  test("creating a label creates it on WhatsApp and refuses a duplicate", async () => {
    const label = await createRyzeLabel(
      ctx(),
      instanceId,
      {
        displayName: "Proposta enviada",
        color: 2,
        description: "Etapa: a proposta foi enviada",
      },
      deps(),
    );
    expect(label.title).toBe("proposta-enviada");
    expect(label.tagId).toBe(ryze.tagNamed("Proposta enviada")?.id ?? "x");
    await expect(
      createRyzeLabel(
        ctx(),
        instanceId,
        { displayName: "Outra", title: "Proposta-Enviada" },
        deps(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("a new chat gets the new_conversation label", async () => {
    await createRyzeLabel(
      ctx(),
      instanceId,
      { displayName: "Novo", autoRule: "new_conversation" },
      deps(),
    );
    const res = await inbound("IN1", "oi");
    expect(res.outcome).toBe("accepted");
    const c = await conv();
    conversationId = c.displayId;
    expect(c.labels).toContain("novo");
    const novo = ryze.tagNamed("Novo") as Tag;
    expect(ryze.assigned.has(`${jid}:${novo.id}`)).toBe(true);
  });

  test("a label the agent sets reaches WhatsApp, and one it drops leaves it", async () => {
    const cw = await client();
    await cw.setConversationLabels(conversationId, [
      "novo",
      "proposta-enviada",
      "lead-frio",
    ]);
    await drainLabelSyncs(gatewayId);
    const proposta = ryze.tagNamed("Proposta enviada") as Tag;
    const frio = ryze.tagNamed("lead-frio") as Tag;
    expect(frio).toBeDefined();
    expect(ryze.assigned.has(`${jid}:${proposta.id}`)).toBe(true);
    expect(ryze.assigned.has(`${jid}:${frio.id}`)).toBe(true);
    const catalog = await listRyzeLabels(ctx(), instanceId, deps());
    expect(catalog.labels.find((l) => l.title === "lead-frio")?.origin).toBe(
      "fazerai",
    );

    await cw.setConversationLabels(conversationId, ["novo", "lead-frio"]);
    await drainLabelSyncs(gatewayId);
    expect(ryze.assigned.has(`${jid}:${proposta.id}`)).toBe(false);
  });

  test("the account label list carries the catalog in WhatsApp colors", async () => {
    const cw = await client();
    const labels = await cw.listLabelsDetailed();
    const vip = labels.find((l) => l.title === "cliente-vip");
    expect(vip?.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("the team labelling on the phone lands on the conversation and is not synced back", async () => {
    const before = ryze.calls.length;
    const res = await hook("label.update", {
      type: "chat",
      labelId: "100",
      action: "add",
      chatJid: `${jid}@s.whatsapp.net`,
      labeled: true,
    });
    expect(res.outcome).toBe("accepted");
    await drainLabelSyncs(gatewayId);
    await drainEmits(gatewayId);
    const c = await conv();
    expect(c.labels).toContain("cliente-vip");
    expect(c.deviceLabels).toEqual(["cliente-vip"]);
    expect(
      ryze.calls.slice(before).filter((x) => x.includes("assignTag")),
    ).toEqual([]);

    const dup = await hook("label.update", {
      type: "chat",
      labelId: "100",
      action: "add",
      chatJid: `${jid}@s.whatsapp.net`,
    });
    expect(dup.outcome).toBe("ignored");
  });

  test("the turn context lists the described catalog and the phone-edited titles", async () => {
    const turn = await runScopedOn(appDb, ctx(), (db) =>
      ryzeLabelTurnContext(db, instanceId, conversationId),
    );
    expect(turn?.deviceLabels).toEqual(["cliente-vip"]);
    expect(
      turn?.catalog.find((l) => l.title === "proposta-enviada")?.description,
    ).toBe("Etapa: a proposta foi enviada");
  });

  test("a label edited on the phone updates the row; one deleted there leaves every conversation", async () => {
    Object.assign(ryze.tags.find((t) => t.id === "100") as Tag, {
      name: "Cliente Ouro",
      color: 7,
    });
    await hook("label.update", {
      type: "edit",
      labelId: "100",
      action: "updated",
      name: "Cliente Ouro",
      color: 7,
      deleted: false,
    });
    let catalog = await listRyzeLabels(ctx(), instanceId, deps());
    expect(catalog.labels.find((l) => l.tagId === "100")).toMatchObject({
      title: "cliente-vip",
      displayName: "Cliente Ouro",
      color: 7,
    });
    await hook("label.update", {
      type: "edit",
      labelId: "100",
      action: "deleted",
      deleted: true,
    });
    const tag = ryze.tags.find((t) => t.id === "100") as Tag;
    tag.deleted = true;
    catalog = await listRyzeLabels(ctx(), instanceId, deps());
    expect(catalog.labels.some((l) => l.tagId === "100")).toBe(false);
    expect((await conv()).labels).not.toContain("cliente-vip");
  });

  test("clear_on_reply leaves the conversation when the contact writes", async () => {
    await createRyzeLabel(
      ctx(),
      instanceId,
      { displayName: "Follow-up 1", autoRule: "clear_on_reply" },
      deps(),
    );
    const cw = await client();
    const current = (await conv()).labels;
    await cw.setConversationLabels(conversationId, [...current, "follow-up-1"]);
    await drainLabelSyncs(gatewayId);
    const fu = ryze.tagNamed("Follow-up 1") as Tag;
    expect(ryze.assigned.has(`${jid}:${fu.id}`)).toBe(true);
    await inbound("IN2", "voltei");
    expect((await conv()).labels).not.toContain("follow-up-1");
    expect(ryze.assigned.has(`${jid}:${fu.id}`)).toBe(false);
  });

  test("human_takeover is on while the conversation is open and off back at pending", async () => {
    await createRyzeLabel(
      ctx(),
      instanceId,
      { displayName: "Humano", autoRule: "human_takeover" },
      deps(),
    );
    const cw = await client();
    await cw.toggleStatus(conversationId, "open");
    await drainLabelSyncs(gatewayId);
    expect((await conv()).labels).toContain("humano");
    await cw.toggleStatus(conversationId, "pending");
    await drainLabelSyncs(gatewayId);
    expect((await conv()).labels).not.toContain("humano");
  });

  test("the human_takeover label put on the phone hands the chat to a human; taken off, back to the agent", async () => {
    const humano = ryze.tagNamed("Humano") as Tag;
    const phone = (action: "add" | "remove") =>
      hook("label.update", {
        type: "chat",
        labelId: humano.id,
        action,
        chatJid: `${jid}@s.whatsapp.net`,
        labeled: action === "add",
      });
    expect((await conv()).status).toBe("pending");
    expect((await phone("add")).outcome).toBe("accepted");
    await drainEmits(gatewayId);
    let c = await conv();
    expect(c.status).toBe("open");
    expect(c.labels).toContain("humano");
    // A redelivery (or the echo of our own sync) changes nothing.
    expect((await phone("add")).outcome).toBe("ignored");
    expect((await conv()).status).toBe("open");
    expect((await phone("remove")).outcome).toBe("accepted");
    await drainEmits(gatewayId);
    c = await conv();
    expect(c.status).toBe("pending");
    expect(c.labels).not.toContain("humano");
  });

  test("an ordinary label put on the phone does not touch the status", async () => {
    const before = (await conv()).status;
    await hook("label.update", {
      type: "chat",
      labelId: "100",
      action: "remove",
      chatJid: `${jid}@s.whatsapp.net`,
    });
    await hook("label.update", {
      type: "chat",
      labelId: "100",
      action: "add",
      chatJid: `${jid}@s.whatsapp.net`,
      labeled: true,
    });
    expect((await conv()).status).toBe(before);
  });

  test("editing keeps the title, and deleting removes it on WhatsApp and from conversations", async () => {
    const catalog = await listRyzeLabels(ctx(), instanceId, deps());
    const frio = catalog.labels.find((l) => l.title === "lead-frio");
    if (!frio) throw new Error("lead-frio missing");
    const edited = await updateRyzeLabel(
      ctx(),
      instanceId,
      BigInt(frio.id),
      { description: "Não respondeu em 7 dias", color: 4 },
      deps(),
    );
    expect(edited).toMatchObject({
      title: "lead-frio",
      description: "Não respondeu em 7 dias",
      color: 4,
    });
    await deleteRyzeLabel(ctx(), instanceId, BigInt(frio.id), deps());
    expect(ryze.tagNamed("lead-frio")).toBeUndefined();
    expect((await conv()).labels).not.toContain("lead-frio");
  });

  test("the 21st live label is refused", async () => {
    const catalog = await listRyzeLabels(ctx(), instanceId, deps());
    for (let i = catalog.labels.length; i < 20; i++) {
      await createRyzeLabel(
        ctx(),
        instanceId,
        { displayName: `Etiqueta ${i}` },
        deps(),
      );
    }
    await expect(
      createRyzeLabel(ctx(), instanceId, { displayName: "Demais" }, deps()),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  test("a number that refuses labels is flagged, keeps the labels local and is not asked again", async () => {
    ryze.refuse = true;
    const catalog = await listRyzeLabels(ctx(), instanceId, deps());
    expect(catalog.labelsSupported).toBe(false);
    const before = ryze.calls.length;
    const cw = await client();
    await cw.setConversationLabels(conversationId, ["so-local"]);
    await drainLabelSyncs(gatewayId);
    expect((await conv()).labels).toEqual(["so-local"]);
    expect(ryze.calls.length).toBe(before);
    expect((await gateway()).labelsSupported).toBe(false);
  });
});
