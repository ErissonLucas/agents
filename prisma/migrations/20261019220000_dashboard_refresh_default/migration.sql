-- A dashboard refreshes every minute by default, and off is no longer a choice (docs/dashboards.md):
-- every period is relative, so figures that stop moving are stale. A dashboard saved at 0 moves to 60;
-- 0 never meant a choice to keep, since the column defaulted to it.
--
-- RLS: a data migration lifts FORCE on every forced table it writes and restores it
-- (.claude/rules/prisma.md, tests/prisma/migration-rls-bypass.test.ts). Without it, a migration run by
-- a non-superuser owner updates no row and the dashboards at 0 keep a value the API now refuses.
BEGIN;
ALTER TABLE "dashboards" ALTER COLUMN "refresh_seconds" SET DEFAULT 60;
ALTER TABLE "dashboards" NO FORCE ROW LEVEL SECURITY;
UPDATE "dashboards" SET "refresh_seconds" = 60 WHERE "refresh_seconds" = 0;
ALTER TABLE "dashboards" FORCE ROW LEVEL SECURITY;
COMMIT;
