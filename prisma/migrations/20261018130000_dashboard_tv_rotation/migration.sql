-- The TV mode's rotation (docs/dashboards.md, "TV mode"): which dashboards a screen alternates and
-- for how long each. Additive, with defaults, in every edition.
ALTER TABLE "dashboards" ADD COLUMN "tv_rotation" BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[];
ALTER TABLE "dashboards" ADD COLUMN "tv_seconds" INTEGER NOT NULL DEFAULT 30;
