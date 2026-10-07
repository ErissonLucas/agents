-- When the number was first seen connected: a chat whose first message is older than this existed before
-- the connection, so the `new_conversation` label rule leaves it alone. Null (gateways connected before
-- this column) keeps the rule as it was.
ALTER TABLE "ryze_gateways" ADD COLUMN "connected_at" TIMESTAMP(3);
