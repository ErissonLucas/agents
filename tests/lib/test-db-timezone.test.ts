import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { withUtcSession } from "../db-name";

describe("withUtcSession", () => {
  test("adds the session time zone and keeps every other part of the URL", () => {
    const out = new URL(
      withUtcSession(
        "postgresql://u:p%40ss@localhost:5433/x_test?sslmode=disable",
      ),
    );
    expect(out.username).toBe("u");
    expect(out.password).toBe("p%40ss");
    expect(out.port).toBe("5433");
    expect(out.pathname).toBe("/x_test");
    expect(out.searchParams.get("sslmode")).toBe("disable");
    expect(out.searchParams.get("options")).toBe("-c TimeZone=UTC");
  });

  test("appends to options already present and never duplicates", () => {
    const once = withUtcSession(
      "postgresql://u@localhost/x_test?options=-c%20statement_timeout%3D5000",
    );
    expect(new URL(once).searchParams.get("options")).toBe(
      "-c statement_timeout=5000 -c TimeZone=UTC",
    );
    expect(withUtcSession(once)).toBe(once);
  });

  test("an explicit TimeZone is left alone", () => {
    const url =
      "postgresql://u@localhost/x_test?options=-c%20TimeZone%3DAmerica%2FRecife";
    expect(withUtcSession(url)).toBe(url);
  });
});

describe("the suite's own connections", () => {
  test("talk to Postgres in UTC whatever the server default is", async () => {
    const url = process.env.TEST_APP_DATABASE_URL as string;
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT current_setting('TimeZone') AS tz, (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone') AS session_default",
      );
      expect(rows[0].tz).toBe("UTC");
      expect(rows[0].session_default).toBe("UTC");
    } finally {
      await client.end();
    }
  });
});
