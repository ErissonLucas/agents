import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  disconnectChatwootDeployment,
  removeChatwootInstance,
} from "@/modules/chatwoot/management";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// DISCONNECTING A DEPLOYMENT HAS TO WORK AT THE SIZE A REAL TENANT REACHES. It takes every account
// of the tenant with it, and each statement is held to the request's budget, so it removes them the
// way a removed account goes. Each test seeds its own tenant in bulk and disconnects it through the
// real function on the app role.
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "SUPER_ADMIN" };
}

const LARGE_TABLES = [
  "chatwoot_webhook_deliveries",
  "conversations",
  "contacts",
  "other_inbox_summaries",
] as const;

// One account in bulk, straight in SQL, as in chatwoot-remove-large-account.test.ts.
async function seedVolume(
  tenantId: bigint,
  instanceId: bigint,
  n: { contacts: number; conversations: number; deliveries: number },
) {
  const tag = `${instanceId}`;
  await suDb.$executeRaw`
    INSERT INTO inboxes (tenant_id, chatwoot_instance_id, chatwoot_inbox_id, name, updated_at)
    SELECT ${tenantId}, ${instanceId}, g, 'inbox ' || g, now() FROM generate_series(1, 3) g`;
  await suDb.$executeRaw`
    INSERT INTO contacts (tenant_id, chatwoot_instance_id, chatwoot_contact_id, updated_at)
    SELECT ${tenantId}, ${instanceId}, g, now() FROM generate_series(1, ${n.contacts}::int) g`;
  await suDb.$executeRaw`
    WITH c AS (SELECT array_agg(id) a FROM contacts WHERE chatwoot_instance_id = ${instanceId}),
         i AS (SELECT array_agg(id) a FROM inboxes WHERE chatwoot_instance_id = ${instanceId})
    INSERT INTO conversations
      (tenant_id, chatwoot_instance_id, inbox_id, contact_id, chatwoot_conversation_id, status, thread_id, updated_at)
    SELECT ${tenantId}, ${instanceId}, i.a[1 + g % 3], c.a[1 + g % array_length(c.a, 1)], g, 'open',
           ${tag} || '-' || g, now()
      FROM generate_series(1, ${n.conversations}::int) g, c, i`;
  // Already processed: a pending row is work a delivery worker in the same process would claim.
  await suDb.$executeRaw`
    INSERT INTO chatwoot_webhook_deliveries
      (tenant_id, chatwoot_instance_id, delivery_id, event, status, processed_at)
    SELECT ${tenantId}, ${instanceId}, ${tag} || '-' || g, 'message_created', 'PROCESSED', now()
      FROM generate_series(1, ${n.deliveries}::int) g`;
  await suDb.$executeRaw`
    INSERT INTO other_inbox_summaries
      (tenant_id, chatwoot_instance_id, chatwoot_conversation_id, summary, covered_message_id,
       covered_fingerprint, generated_at, updated_at)
    SELECT ${tenantId}, ${instanceId}, g, 'summary', g, 'f', now(), now()
      FROM generate_series(1, ${n.conversations}::int) g`;
  await suDb.$executeRawUnsafe(
    "ANALYZE inboxes, contacts, conversations, chatwoot_webhook_deliveries, other_inbox_summaries",
  );
}

// What is left of the tenant's Chatwoot side.
async function rowsOf(tenantId: bigint) {
  const [row] = await suDb.$queryRaw<Record<string, bigint>[]>`
    SELECT (SELECT count(*) FROM chatwoot_deployments WHERE tenant_id = ${tenantId}) AS deployments,
           (SELECT count(*) FROM chatwoot_instances WHERE tenant_id = ${tenantId}) AS accounts,
           (SELECT count(*) FROM inboxes WHERE tenant_id = ${tenantId}) AS inboxes,
           (SELECT count(*) FROM contacts WHERE tenant_id = ${tenantId}) AS contacts,
           (SELECT count(*) FROM conversations WHERE tenant_id = ${tenantId}) AS conversations,
           (SELECT count(*) FROM chatwoot_webhook_deliveries WHERE tenant_id = ${tenantId}) AS deliveries,
           (SELECT count(*) FROM other_inbox_summaries WHERE tenant_id = ${tenantId}) AS summaries`;
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]),
  );
}

const EMPTY = {
  deployments: 0,
  accounts: 0,
  inboxes: 0,
  contacts: 0,
  conversations: 0,
  deliveries: 0,
  summaries: 0,
};

async function disconnectAudit(tenantId: bigint) {
  return suDb.$queryRaw<{ before: unknown }[]>`
    SELECT before FROM audit_logs
     WHERE tenant_id = ${tenantId} AND action = 'deployment.disconnect' ORDER BY id`;
}

// The app client with a hook in front of the N-th scoped transaction it opens.
function beforeTransaction(n: number, hook: () => Promise<void>) {
  let scoped = 0;
  return new Proxy(appDb, {
    get(target, prop, receiver) {
      if (prop !== "$extends") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const ext = (
          target as unknown as { $extends: (...a: unknown[]) => object }
        ).$extends(...args);
        return new Proxy(ext, {
          get(et, ep, er) {
            if (ep !== "$transaction") return Reflect.get(et, ep, er);
            return async (...targs: unknown[]) => {
              scoped++;
              if (scoped === n) await hook();
              return (
                et as unknown as {
                  $transaction: (...a: unknown[]) => Promise<unknown>;
                }
              ).$transaction(...targs);
            };
          },
        });
      };
    },
  });
}

describe.skipIf(!dbUp)("disconnecting a large Chatwoot deployment", () => {
  const tenants: bigint[] = [];

  afterAll(async () => {
    for (const id of tenants) {
      await suDb.$executeRaw`DELETE FROM chatwoot_webhook_deliveries WHERE tenant_id = ${id}`;
      await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${id}`;
      await suDb.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${id}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${id}`;
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // A tenant with a large account and a small one under its deployment, plus an agent of its own.
  async function largeTenant(slug: string, big: number) {
    const t = await suDb.tenant.create({
      data: { name: slug, slug: `${slug}-${process.pid}` },
    });
    tenants.push(t.id);
    const accounts = [];
    for (const [accountId, size] of [
      [1, big],
      [2, 50],
    ] as const) {
      const inst = await seedChatwootInstance(suDb, {
        tenantId: t.id,
        accountId,
        accountName: `Account ${accountId}`,
        baseUrl: `https://chat.${slug}-${process.pid}.example.com`,
        adminToken: encryptJson("ADMIN"),
      });
      await seedVolume(t.id, inst.id, {
        contacts: Math.max(10, Math.floor(size / 10)),
        conversations: size,
        deliveries: size,
      });
      accounts.push(inst);
    }
    await suDb.agent.create({
      data: { tenantId: t.id, name: "Stays", systemPrompt: "x" },
    });
    return { tenantId: t.id, accounts };
  }

  // How big a tenant gets is not bounded, and the request's budget applies to each statement: one
  // cascade of the deployment fails once the accounts under it outgrow the budget. Timing that here
  // would measure this machine's load, so the test counts instead: a statement-level trigger on
  // each large table refuses any single statement, the cascade's internal ones included, that
  // deletes more of this tenant's rows than the cap.
  test("no statement of a deployment disconnect deletes more than a bounded number of rows", async () => {
    const { tenantId } = await largeTenant("large-disconnect", 12_000);
    const seeded = await rowsOf(tenantId);
    await suDb.$executeRawUnsafe(`
      CREATE FUNCTION test_1537_statement_cap() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n bigint;
      BEGIN
        SELECT count(*) INTO n FROM old_rows WHERE tenant_id = ${tenantId};
        IF n > 5000 THEN
          RAISE EXCEPTION 'one statement deleted % rows of %', n, TG_TABLE_NAME;
        END IF;
        RETURN NULL;
      END $$`);
    try {
      for (const table of LARGE_TABLES) {
        await suDb.$executeRawUnsafe(
          `CREATE TRIGGER test_1537_statement_cap AFTER DELETE ON ${table}
             REFERENCING OLD TABLE AS old_rows
             FOR EACH STATEMENT EXECUTE FUNCTION test_1537_statement_cap()`,
        );
      }

      await disconnectChatwootDeployment(ctx(tenantId), appDb);
    } finally {
      for (const table of LARGE_TABLES) {
        await suDb.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS test_1537_statement_cap ON ${table}`,
        );
      }
      await suDb.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS test_1537_statement_cap()",
      );
    }

    expect(await rowsOf(tenantId)).toEqual(EMPTY);
    // One record, describing what was there before anything went.
    const audit = await disconnectAudit(tenantId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({
      accounts: 2,
      inboxes: seeded.inboxes,
      contacts: seeded.contacts,
    });
    // The tenant itself and its agents stay: only the Chatwoot side goes.
    expect(await suDb.tenant.count({ where: { id: tenantId } })).toBe(1);
    expect(await suDb.agent.count({ where: { tenantId } })).toBe(1);
  }, 180_000);

  // Statistics trail the rows: an account that grew since the table was last analyzed is the normal
  // case, not the exception, and each batch still has to cost the same. The budget is the default one,
  // and the account is large enough that one batch walking it per picked row outlasts it.
  test("an account that grew after its table was analyzed is still disconnected within the budget", async () => {
    await suDb.$executeRawUnsafe(
      "ANALYZE chatwoot_webhook_deliveries, conversations, contacts",
    );
    const t = await suDb.tenant.create({
      data: { name: "stale", slug: `stale-disconnect-${process.pid}` },
    });
    tenants.push(t.id);
    const inst = await seedChatwootInstance(suDb, {
      tenantId: t.id,
      accountId: 1,
      baseUrl: `https://chat.stale-${process.pid}.example.com`,
      adminToken: encryptJson("ADMIN"),
    });
    await suDb.$executeRaw`
      INSERT INTO chatwoot_webhook_deliveries
        (tenant_id, chatwoot_instance_id, delivery_id, event, status, processed_at)
      SELECT ${t.id}, ${inst.id}, 'stale-' || g, 'message_created', 'PROCESSED', now()
        FROM generate_series(1, 80000) g`;

    await disconnectChatwootDeployment(ctx(t.id), appDb);

    expect(await rowsOf(t.id)).toEqual(EMPTY);
  }, 180_000);

  // The disconnect is many transactions, so it can stop between them. What it leaves has to take no
  // traffic, claim nothing in the trail, and finish when the operator runs it again.
  test("a disconnect stopped halfway leaves the accounts disconnected, and running it again finishes", async () => {
    const { tenantId, accounts } = await largeTenant(
      "halfway-disconnect",
      3_000,
    );
    const agent = await suDb.agent.findFirstOrThrow({ where: { tenantId } });
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { chatwootInstanceId: accounts[0]?.id },
    });
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { agentId: agent.id },
    });
    // The claim, the voice switch-off's read, then the batches: the fifth is the third batch of the
    // first account's delivery log.
    const dying = beforeTransaction(5, async () => {
      throw new Error("connection lost");
    });
    await expect(
      disconnectChatwootDeployment(ctx(tenantId), dying),
    ).rejects.toThrow("connection lost");

    const halfway = await rowsOf(tenantId);
    expect(halfway.deployments).toBe(1);
    expect(halfway.accounts).toBe(2);
    expect(halfway.deliveries).toBeLessThan(3_050);
    expect(
      await suDb.chatwootInstance.count({
        where: { tenantId, disconnectedAt: null },
      }),
    ).toBe(0);
    expect(
      await suDb.inbox.count({ where: { tenantId, agentId: { not: null } } }),
    ).toBe(0);
    expect(await disconnectAudit(tenantId)).toHaveLength(0);

    await disconnectChatwootDeployment(ctx(tenantId), appDb);

    expect(await rowsOf(tenantId)).toEqual(EMPTY);
    expect(await disconnectAudit(tenantId)).toHaveLength(1);
  }, 180_000);

  // Two clicks on "Disconnect" are two disconnects running together. Neither may fail on what the
  // other already deleted; the one that arrives after the deployment is gone says so (404).
  test("two disconnects of the same deployment at once both end without an error other than not found", async () => {
    const { tenantId } = await largeTenant("twice-disconnect", 3_000);

    const results = await Promise.allSettled([
      disconnectChatwootDeployment(ctx(tenantId), appDb),
      disconnectChatwootDeployment(ctx(tenantId), appDb),
    ]);

    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(NotFoundError);
    }
    expect(await rowsOf(tenantId)).toEqual(EMPTY);
    expect(await disconnectAudit(tenantId)).toHaveLength(1);
  }, 180_000);

  // Removing one account while the whole deployment is disconnected: both walk the same account,
  // and the one that finds it gone moves on.
  test("a disconnect racing the removal of one of its accounts leaves nothing behind", async () => {
    const { tenantId, accounts } = await largeTenant("race-disconnect", 3_000);

    const results = await Promise.allSettled([
      disconnectChatwootDeployment(ctx(tenantId), appDb),
      removeChatwootInstance(ctx(tenantId), accounts[0]?.id as bigint, appDb),
    ]);

    for (const r of results) {
      if (r.status === "rejected")
        expect(
          r.reason instanceof NotFoundError ||
            r.reason instanceof ConflictError,
        ).toBe(true);
    }
    expect(results[0]?.status).toBe("fulfilled");
    expect(await rowsOf(tenantId)).toEqual(EMPTY);
  }, 180_000);

  // The claim is one transaction under the request's budget, so what it does cannot grow with the
  // number of accounts: a deployment of many small accounts has to fit as well as one of a single
  // large one. Counted as statements, not timed.
  test("claiming the accounts costs the same statements for thirty accounts as for one", async () => {
    async function claimStatements(accounts: number) {
      const t = await suDb.tenant.create({
        data: {
          name: "many",
          slug: `many-${accounts}-disconnect-${process.pid}`,
        },
      });
      tenants.push(t.id);
      for (let a = 1; a <= accounts; a++) {
        const inst = await seedChatwootInstance(suDb, {
          tenantId: t.id,
          accountId: a,
          baseUrl: `https://chat.many-${accounts}-${process.pid}.example.com`,
          adminToken: encryptJson("ADMIN"),
        });
        await suDb.$executeRaw`
          INSERT INTO inboxes (tenant_id, chatwoot_instance_id, chatwoot_inbox_id, name, updated_at)
          VALUES (${t.id}, ${inst.id}, 1, 'inbox', now())`;
      }
      let scoped = 0;
      let statements = 0;
      const counting = new Proxy(appDb, {
        get(target, prop, receiver) {
          if (prop !== "$extends") return Reflect.get(target, prop, receiver);
          return (...args: unknown[]) => {
            const ext = (
              target as unknown as { $extends: (...a: unknown[]) => object }
            ).$extends(...args);
            return new Proxy(ext, {
              get(et, ep, er) {
                if (ep !== "$transaction") return Reflect.get(et, ep, er);
                return (
                  fn: (tx: object) => Promise<unknown>,
                  ...rest: unknown[]
                ) => {
                  const first = ++scoped === 1;
                  return (
                    et as unknown as {
                      $transaction: (...a: unknown[]) => Promise<unknown>;
                    }
                  ).$transaction(
                    (tx: object) =>
                      fn(
                        first
                          ? new Proxy(tx, {
                              get(tt, tp, tr) {
                                if (tp === "$queryRaw" || tp === "$executeRaw")
                                  statements++;
                                return Reflect.get(tt, tp, tr);
                              },
                            })
                          : tx,
                      ),
                    ...rest,
                  );
                };
              },
            });
          };
        },
      });
      await disconnectChatwootDeployment(ctx(t.id), counting);
      expect(await rowsOf(t.id)).toEqual(EMPTY);
      return statements;
    }

    expect(await claimStatements(30)).toBe(await claimStatements(1));
  }, 180_000);

  test("a deployment with no accounts is disconnected and recorded with zero counts", async () => {
    const t = await suDb.tenant.create({
      data: { name: "empty", slug: `empty-disconnect-${process.pid}` },
    });
    tenants.push(t.id);
    await suDb.chatwootDeployment.create({
      data: {
        tenantId: t.id,
        baseUrl: `https://chat.empty-${process.pid}.example.com`,
        adminToken: encryptJson("ADMIN"),
      },
    });

    await disconnectChatwootDeployment(ctx(t.id), appDb);

    expect(await rowsOf(t.id)).toEqual(EMPTY);
    const audit = await disconnectAudit(t.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({
      accounts: 0,
      inboxes: 0,
      contacts: 0,
    });
  });
});
