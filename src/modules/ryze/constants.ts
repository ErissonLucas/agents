// The emulated Chatwoot answers on a TEST-NET-3 literal (RFC 5737): it is never routed, it passes the
// outbound guard without a DNS lookup, and the emulator's fetch intercepts every URL under it before
// any socket opens. An attachment's data_url lives under the same root, so the download path takes
// the "same host" branch exactly as it does against a real Chatwoot.
export const RYZE_EMULATOR_ROOT = "https://203.0.113.250/ryze-emulator";

export function ryzeEmulatorBaseUrl(instanceId: bigint): string {
  return `${RYZE_EMULATOR_ROOT}/${instanceId}`;
}

// Every emulated account is account 1 of its own emulated server.
export const RYZE_EMULATED_ACCOUNT_ID = 1;

// The inbox as the runtime sees it. `provider` joins the echo-reserving set in normalize.ts: the
// emulator records a send before RyzeAPI is called and drops our own echoes by their `source`, so a
// message typed on the paired phone is the only outgoing event that can reach the receiver unsent.
export const RYZE_CHANNEL_TYPE = "Channel::Api";
export const RYZE_PROVIDER = "ryze";

// What a WhatsApp session provider writes on a message typed on the paired phone, and what
// `hasDeviceAttendantShape` recognises as a person answering from the device.
export const RYZE_DEVICE_SENDER_NAME = "WhatsApp";

// The operator identity behind admin-token sends, which Chatwoot would attribute to a user.
export const RYZE_OPERATOR_USER = { id: 1, name: "fazer.ai" } as const;

export const RYZE_WEBHOOK_MOUNT = "/api/v1/ryze/webhook";

// What RyzeAPI reports (instance.state, /api/instance/list) for a number that is up.
export const RYZE_CONNECTED_STATE = "connected";
