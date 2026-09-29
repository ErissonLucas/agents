import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ForbiddenError,
  TenantTargetRequiredError,
  UnauthorizedError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { sendRyzeCard, sendRyzeText } from "@/modules/ryze/interactive";
import { receiveRyzeWebhook } from "@/modules/ryze/receiver";
import {
  connectRyzeGateway,
  listRyzeGateways,
  pairRyzeGateway,
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
  async ({ params, request }) => {
    const rawBody = await request.text();
    const result = await receiveRyzeWebhook({
      routeToken: params.routeToken,
      rawBody,
      authorization: request.headers.get("authorization"),
    });
    if (result.status === 401) throw new UnauthorizedError();
    if (result.status === 400) throw new AppError("invalid payload", 400);
    if (result.status >= 500) throw new AppError("processing failed", 500);
    return { ack: true, outcome: result.outcome };
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
  .post(
    "/gateways/:id/pair",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      pairing: await pairRyzeGateway(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        { number: body?.number || undefined },
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Pair RyzeAPI number",
        "Where the number's WhatsApp login stands: connected, or a fresh QR code (PNG data URL) to scan, or an 8-character pairing code when a phone number is given. RyzeAPI holds the call until it has a code (up to about a minute).",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
      }),
      body: t.Optional(
        t.Object({
          number: t.Optional(
            t.String({
              description:
                "Phone in international format, to get a pairing code instead of a QR.",
            }),
          ),
        }),
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/gateways/:id/cards",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      card: await sendRyzeCard(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Send RyzeAPI button card",
        "Send a card with 1 to 3 reply buttons into the contact's conversation on this number. The card is stored as the agent's own message, so it is part of the history the model reads and is never taken for a person typing on the phone. A tap on a button whose id carries RYZE_BUTTON_BRIDGE_PREFIX is posted to RYZE_BUTTON_BRIDGE_URL instead of starting an agent turn.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
      }),
      body: t.Object({
        to: t.String({
          description: "Recipient phone, digits only, with country code.",
        }),
        text: t.String({ minLength: 1, description: "Card body." }),
        header: t.Optional(t.String({ description: "Bold header line." })),
        footer: t.Optional(t.String({ description: "Small footer line." })),
        mediaUrl: t.Optional(
          t.String({
            description: "https URL of an image shown with the card.",
          }),
        ),
        buttons: t.Array(
          t.Object({
            id: t.String({
              description:
                "Button id returned on tap (A-Z a-z 0-9 : _ -, up to 128).",
            }),
            title: t.String({
              description: "Button label, up to 20 characters.",
            }),
          }),
          { minItems: 1, maxItems: 3 },
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/gateways/:id/messages",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      message: await sendRyzeText(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Send RyzeAPI text",
        "Send a plain text into the contact's conversation on this number. The text is stored as the agent's own message, so it is part of the history the model reads and is never taken for a person typing on the phone. A Brazilian mobile reuses the conversation stored with or without the ninth digit.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
      }),
      body: t.Object({
        to: t.String({
          description: "Recipient phone, digits only, with country code.",
        }),
        text: t.String({
          minLength: 1,
          maxLength: 4000,
          description: "Message text, up to 4000 characters.",
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
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
