import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { receiveRyzeWebhook } from "@/modules/ryze/receiver";
import {
  connectRyzeGateway,
  listRyzeGateways,
  refreshRyzeGateway,
  removeRyzeGateway,
} from "@/modules/ryze/service";

// translate('errors.ryzeConnectFailed', 'Could not reach the RyzeAPI instance: {{detail}}')
// translate('errors.ryzeGatewayNotFound', 'RyzeAPI number not found.')
// translate('errors.ryzeGatewaysBlockDisconnect', 'Remove the RyzeAPI numbers before disconnecting Chatwoot.')

// RyzeAPI as a WhatsApp channel beside Chatwoot. The webhook route is public and JWT-less: the opaque
// route token names the gateway and the static Authorization value we configured on it authenticates
// the call. The management routes connect, list, refresh and remove numbers; binding a number to an
// agent goes through the Chatwoot inbox routes, since the number is an emulated Chatwoot inbox.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const ryzeWebhookController = new Elysia({
  prefix: "/v1/ryze",
  tags: ["Channels"],
}).post(
  "/webhook/:routeToken",
  async ({ params, request, set }) => {
    const rawBody = await request.text();
    const result = await receiveRyzeWebhook({
      routeToken: params.routeToken,
      rawBody,
      authorization: request.headers.get("authorization"),
    });
    set.status = result.status;
    return { ack: result.status < 300, outcome: result.outcome };
  },
  {
    detail: {
      ...doc(
        "RyzeAPI webhook",
        "Public RyzeAPI webhook receiver; authenticated by the opaque per-number route token plus the Authorization value configured on the gateway (verified in-handler), not by a session. An unknown token and a wrong Authorization answer the same 401.",
      ),
      security: [],
    },
    params: t.Object({
      routeToken: t.String({ description: "Opaque per-number route token." }),
    }),
    response: errors(400, 401, 500),
  },
);

export const ryzeAdminController = new Elysia({
  prefix: "/v1/ryze",
  tags: ["Channels"],
})
  .use(tenancyPlugin)
  .get(
    "/gateways",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      gateways: await listRyzeGateways(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List RyzeAPI numbers",
        "The tenant's WhatsApp numbers connected through RyzeAPI, with the last connection state reported.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/gateways",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      gateway: await connectRyzeGateway(ctxOrThrow(tenantContext), body),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Connect RyzeAPI number",
        "Connect a RyzeAPI instance as a WhatsApp channel: validates the token, registers our webhook on the instance and creates the inbox, which is then bound to an agent like any other inbox.",
      ),
      body: t.Object({
        name: t.String({
          minLength: 1,
          description: "Display name of the number.",
        }),
        baseUrl: t.String({
          description: "RyzeAPI base URL, e.g. https://ryzeapi.cloud.",
        }),
        instanceName: t.String({
          minLength: 1,
          description: "RyzeAPI instance name.",
        }),
        token: t.String({
          minLength: 1,
          description: "RyzeAPI instance token (write-only).",
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/gateways/:id/refresh",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      gateway: await refreshRyzeGateway(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Refresh RyzeAPI number",
        "Ask RyzeAPI for the number's live connection state and store it.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  .delete(
    "/gateways/:id",
    async ({ tenantContext, params }) => {
      await removeRyzeGateway(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Remove RyzeAPI number",
        "Stop RyzeAPI delivering to this server and remove the number with its conversations and bindings.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  );
