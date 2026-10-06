import { expect, test } from "bun:test";
import { Client } from "pg";
import { normalizeToolName } from "@/graph/tools/toolName";

const migration =
  "prisma/migrations/20261005180000_rename_http_tools_named_after_natives/migration.sql";

test("interactive native names preserve custom tools, grants, guards and audit across tenants", async () => {
  const db = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await db.connect();
  try {
    const tenants: string[] = [];
    for (const suffix of ["a", "b"]) {
      const result = await db.query(
        "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ('interactive migration', $1, NOW(), NOW()) RETURNING id",
        [`interactive-migration-${crypto.randomUUID()}-${suffix}`],
      );
      tenants.push(String(result.rows[0].id));
    }
    const a = tenants[0];
    const b = tenants[1];
    const http = async (tenant: string | undefined, name: string) => {
      const result = await db.query(
        `INSERT INTO tool_definitions (tenant_id, name, label, url_template, allowed_hosts, created_at, updated_at) VALUES ($1, $2, $2, 'https://example.test', '{example.test}', NOW(), NOW()) RETURNING id`,
        [tenant, name],
      );
      return String(result.rows[0].id);
    };
    const code = async (name: string) => {
      const result = await db.query(
        `INSERT INTO code_tool_definitions (tenant_id, name, label, description, code, created_at, updated_at) VALUES ($1, $2, $2, 'd', 'return {}', NOW(), NOW()) RETURNING id`,
        [a, name],
      );
      return String(result.rows[0].id);
    };
    const h = await http(a, "send_buttons");
    await code("send_buttons_2");
    const c = await code("send_carousel");
    await http(a, "send_carousel_2");
    const other = await http(b, "send_buttons");
    const untouched = await http(a, "lookup_order");
    const initial = (
      await db.query("SELECT * FROM tool_definitions WHERE id=$1", [untouched])
    ).rows[0];
    const settings = {
      toolGuidance: {
        send_buttons: "button hint",
        send_carousel: "carousel hint",
      },
      toolPreconditions: {
        send_buttons: { requiredLabels: ["safe"] },
        send_carousel: { requiredLabels: ["ready"] },
      },
    };
    const ag = (
      await db.query(
        `INSERT INTO agents (tenant_id,name,system_prompt,model_config,settings,created_at,updated_at) VALUES ($1,'interactive migration','Use send_buttons and send_carousel','{}',$2,NOW(),NOW()) RETURNING id`,
        [a, JSON.stringify(settings)],
      )
    ).rows[0].id;
    for (const [source, column, id] of [
      ["HTTP", "tool_definition_id", h],
      ["CODE", "code_tool_definition_id", c],
    ]) {
      await db.query(
        `INSERT INTO agent_tool_selections (tenant_id,agent_id,source,${column},knowledge_base_ids,enabled_tools,created_at,updated_at) VALUES ($1,$2,$3,$4,'{}','{}',NOW(),NOW())`,
        [a, ag, source, id],
      );
    }
    const grantsBefore = (
      await db.query(
        "SELECT * FROM agent_tool_selections WHERE agent_id=$1 ORDER BY id",
        [ag],
      )
    ).rows;
    const sql = await Bun.file(migration).text();
    await db.query(sql);
    const renamed = (
      await db.query("SELECT name,label FROM tool_definitions WHERE id=$1", [h])
    ).rows[0];
    expect(renamed.name).toBe("send_buttons_3");
    expect(normalizeToolName(renamed.label)).toBe(renamed.name);
    expect(
      (
        await db.query("SELECT name FROM code_tool_definitions WHERE id=$1", [
          c,
        ])
      ).rows[0].name,
    ).toBe("send_carousel_3");
    expect(
      (await db.query("SELECT name FROM tool_definitions WHERE id=$1", [other]))
        .rows[0].name,
    ).toBe("send_buttons_2");
    expect(
      (
        await db.query("SELECT * FROM tool_definitions WHERE id=$1", [
          untouched,
        ])
      ).rows[0],
    ).toEqual(initial);
    expect(
      (
        await db.query(
          "SELECT * FROM agent_tool_selections WHERE agent_id=$1 ORDER BY id",
          [ag],
        )
      ).rows,
    ).toEqual(grantsBefore);
    const agent = (
      await db.query("SELECT settings,system_prompt FROM agents WHERE id=$1", [
        ag,
      ])
    ).rows[0];
    expect(agent.settings).toEqual({
      toolGuidance: {
        send_buttons_3: "button hint",
        send_carousel_3: "carousel hint",
      },
      toolPreconditions: {
        send_buttons_3: { requiredLabels: ["safe"] },
        send_carousel_3: { requiredLabels: ["ready"] },
      },
    });
    expect(agent.system_prompt).toBe("Use send_buttons and send_carousel");
    const audit = (
      await db.query(
        "SELECT * FROM audit_logs WHERE tenant_id=ANY($1::bigint[]) ORDER BY id",
        [tenants],
      )
    ).rows;
    expect(
      audit.filter((r) => r.action === "tool.renamed_by_upgrade"),
    ).toHaveLength(3);
    expect(
      audit.filter((r) => r.action === "agent.prompt_names_renamed_tool"),
    ).toHaveLength(2);
    await db.query(sql);
    expect(
      (
        await db.query(
          "SELECT * FROM audit_logs WHERE tenant_id=ANY($1::bigint[]) ORDER BY id",
          [tenants],
        )
      ).rows,
    ).toEqual(audit);
    const forced = (
      await db.query(
        "SELECT relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])",
        [
          [
            "tool_definitions",
            "code_tool_definitions",
            "agents",
            "agent_tool_selections",
            "audit_logs",
          ],
        ],
      )
    ).rows;
    expect(forced).toHaveLength(5);
    expect(forced.every((r) => r.relforcerowsecurity)).toBe(true);
    // Synthetic rows are deliberately retained; no database or audit evidence is removed.
  } finally {
    await db.end();
  }
});
