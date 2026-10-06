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
import {
  createRyzeLabel,
  deleteRyzeLabel,
  listRyzeLabels,
  updateRyzeLabel,
} from "@/modules/ryze/labels";
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

// translate('errors.ryzeLabelDescriptionTooLong', '"When to use" takes at most {{max}} characters.')
// translate('errors.ryzeLabelColorInvalid', 'The label color must be one of the 11 WhatsApp colors (0 to 10).')
// translate('errors.ryzeLabelRuleInvalid', 'Unknown automatic rule for the label.')
// translate('errors.ryzeLabelNameInvalid', 'A label name takes 1 to {{max}} characters.')
// translate('errors.ryzeLabelLimit', 'A WhatsApp Business number holds at most {{max}} labels. Delete one before creating another.')
// translate('errors.ryzeLabelExists', 'A label with this name already exists on this number.')
// translate('errors.ryzeLabelNotFound', 'Label not found.')

// RyzeAPI as a WhatsApp channel beside Chatwoot. The webhook route is public and JWT-less: the opaque
// route token names the gateway and the static Authorization value we configured on it authenticates
// the call. The management routes connect, list, refresh and remove numbers; binding a number to an
// agent goes through the Chatwoot inbox routes, since the number is an emulated Chatwoot inbox.

const attributeBag = (what: string) =>
  t.Optional(
    t.Record(
      t.String(),
      t.Union([t.String({ maxLength: 1000 }), t.Number(), t.Boolean()]),
      {
        description: `Custom attributes merged into the ${what}'s before the message goes (keys A-Z a-z 0-9 _ -, up to 64; at most 50; a string value up to 1000 characters). Keys not named keep their value.`,
      },
    ),
  );

// Optional context a send writes on the conversation first, so the agent reads it on the reply.
const conversationContextFields = {
  contactName: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 255,
      description: "Contact name, set only when the contact has none yet.",
    }),
  ),
  contactAttributes: attributeBag("contact"),
  conversationAttributes: attributeBag("conversation"),
  labels: t.Optional(
    t.Array(
      t.String({
        minLength: 1,
        maxLength: 40,
        description: "Label title (a-z 0-9 _ -, up to 40).",
      }),
      {
        maxItems: 10,
        description:
          "Labels ADDED to the conversation (never removed), synced to WhatsApp Business like any label write. At most 10.",
      },
    ),
  ),
};

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
        "Send a card with 1 to 3 reply buttons into the contact's conversation on this number. The card is stored as the agent's own message, so it is part of the history the model reads and is never taken for a person typing on the phone. A tap on a button whose id carries RYZE_BUTTON_BRIDGE_PREFIX is posted to RYZE_BUTTON_BRIDGE_URL instead of starting an agent turn. Optional `contactName`, `contactAttributes`, `conversationAttributes` and `labels` are written on the contact and conversation (created if the contact never wrote) before the message is stored and sent, merged into what is there, so the agent reads them when the contact answers.",
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
            id: t.Optional(
              t.String({
                description:
                  "Reply button: id returned on tap (A-Z a-z 0-9 : _ -, up to 128).",
              }),
            ),
            url: t.Optional(
              t.String({
                description:
                  "Link button: https URL opened on tap. A card takes reply buttons or link/copy buttons, not both.",
              }),
            ),
            copy: t.Optional(
              t.String({
                description:
                  "Copy button: code copied on tap (A-Z a-z 0-9 _ -, up to 40).",
              }),
            ),
            title: t.String({
              description: "Button label, up to 20 characters.",
            }),
          }),
          { minItems: 1, maxItems: 3 },
        ),
        ...conversationContextFields,
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
        "Send a plain text into the contact's conversation on this number. The text is stored as the agent's own message, so it is part of the history the model reads and is never taken for a person typing on the phone. A Brazilian mobile reuses the conversation stored with or without the ninth digit. Optional `contactName`, `contactAttributes`, `conversationAttributes` and `labels` are written on the contact and conversation (created if the contact never wrote) before the message is stored and sent, merged into what is there, so the agent reads them when the contact answers.",
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
        ...conversationContextFields,
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/gateways/:id/labels",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      catalog: await listRyzeLabels(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List RyzeAPI number labels",
        "The number's WhatsApp Business labels, after importing the ones created on the phone. `labelsSupported` is false when the number refused label calls (not WhatsApp Business): the labels then live only here.",
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
    "/gateways/:id/labels",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      label: await createRyzeLabel(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create RyzeAPI number label",
        "Create a label on WhatsApp (when the number is WhatsApp Business) and in the catalog. At most 20 live labels per number.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
      }),
      body: t.Object({
        displayName: t.String({
          minLength: 1,
          maxLength: 40,
          description: "Name shown on WhatsApp.",
        }),
        title: t.Optional(
          t.String({
            maxLength: 40,
            description:
              "Internal title the agent uses; defaults to a slug of displayName.",
          }),
        ),
        color: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: 10,
            description: "WhatsApp palette index, 0 to 10.",
          }),
        ),
        description: t.Optional(
          t.Nullable(
            t.String({
              maxLength: 300,
              description: "When to use it; shown to the agent.",
            }),
          ),
        ),
        autoRule: t.Optional(
          t.Nullable(
            t.Union(
              [
                t.Literal("clear_on_reply"),
                t.Literal("human_takeover"),
                t.Literal("new_conversation"),
              ],
              { description: "Automatic rule, or null for none." },
            ),
          ),
        ),
      }),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .patch(
    "/gateways/:id/labels/:labelId",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      label: await updateRyzeLabel(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        requireDbId(params.labelId),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update RyzeAPI number label",
        "Change when to use a label, its automatic rule or its color. RyzeAPI cannot edit a label, so a new color shows here only, not on the phone.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
        labelId: t.String({ description: "Label id." }),
      }),
      body: t.Object({
        color: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: 10,
            description: "WhatsApp palette index, 0 to 10 (local only).",
          }),
        ),
        description: t.Optional(
          t.Nullable(
            t.String({
              maxLength: 300,
              description: "When to use it; shown to the agent.",
            }),
          ),
        ),
        autoRule: t.Optional(
          t.Nullable(
            t.Union(
              [
                t.Literal("clear_on_reply"),
                t.Literal("human_takeover"),
                t.Literal("new_conversation"),
              ],
              { description: "Automatic rule, or null for none." },
            ),
          ),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/gateways/:id/labels/:labelId",
    async ({ tenantContext, params }) => {
      await deleteRyzeLabel(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        requireDbId(params.labelId),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete RyzeAPI number label",
        "Delete the label on WhatsApp and in the catalog, and take it off every conversation of the number.",
      ),
      params: t.Object({
        id: t.String({
          description: "Account (Chatwoot instance) id of the number.",
        }),
        labelId: t.String({ description: "Label id." }),
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
