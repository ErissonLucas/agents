/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ToastProvider } from "@/client/components/Toast";
import { RyzeSection } from "@/client/pages/channels/RyzeSection";

// The console path for a RyzeAPI number: the empty state opens the connect modal, the credentials
// connect the number, a number that is not paired yet shows the QR RyzeAPI returned, and once the
// status reads connected the modal moves on to the agent that answers, whose choice binds the inbox.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect (a DOM node in a failing
// expect stalls the runner).

const QR = "data:image/png;base64,iVBORw0KGgo=";

function gateway(state: string) {
  return {
    instanceId: "9",
    inboxDbId: "41",
    agentId: null,
    name: "Amanda Sena",
    instanceName: "amanda",
    baseUrl: "https://ryzeapi.cloud",
    inboxId: 1500000001,
    connectionState: state,
    numberJid: null,
    lastEventAt: null,
    createdAt: "2026-09-28T00:00:00.000Z",
  };
}

describe("RyzeSection", () => {
  const realFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  let listed: ReturnType<typeof gateway>[] = [];
  let refreshes = 0;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as Request).url ?? input);
    const method = String(init?.method ?? "GET");
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes("/api/v1/ryze/gateways/9/pair")) {
      return json({
        pairing: {
          connected: false,
          connectionState: "disconnected",
          numberJid: null,
          qrCodeBase64: QR,
          pairingCode: null,
        },
      });
    }
    if (url.includes("/api/v1/ryze/gateways/9/refresh")) {
      refreshes += 1;
      return json({ gateway: gateway("connected") });
    }
    if (url.includes("/api/v1/ryze/gateways")) {
      if (method === "POST") return json({ gateway: gateway("disconnected") });
      return json({ gateways: listed });
    }
    if (url.includes("/api/v1/chatwoot/inboxes/41")) return json({ inbox: {} });
    return json({});
  }) as unknown as typeof globalThis.fetch;

  afterEach(() => {
    cleanup();
    calls.length = 0;
    listed = [];
    refreshes = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("connect, pair by QR, then bind the answering agent", async () => {
    render(
      <ToastProvider>
        <RyzeSection
          agents={[{ id: "7", name: "Lara" }]}
          onChanged={() => {}}
          renderAgentPicker={() => null}
        />
      </ToastProvider>,
    );
    const open = await waitFor(() => {
      const b = screen.queryAllByRole("button", {
        name: /Connect number|Conectar número/,
      });
      if (b.length === 0) throw new Error("not yet");
      return b[0] as HTMLElement;
    });
    fireEvent.click(open);

    const inputs = await waitFor(() => {
      const found = screen.queryAllByRole("textbox");
      if (found.length < 3) throw new Error("not yet");
      return found;
    });
    fireEvent.change(inputs[0] as HTMLElement, {
      target: { value: "Amanda Sena" },
    });
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: "amanda" } });
    const token = document.querySelector('input[type="password"]');
    fireEvent.change(token as HTMLElement, { target: { value: "tok" } });
    fireEvent.click(
      screen.getByRole("button", { name: /^(Continue|Continuar)$/ }),
    );

    await waitFor(() =>
      expect(!!document.querySelector(`img[src="${QR}"]`)).toBe(true),
    );
    const connect = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/api/v1/ryze/gateways"),
    );
    expect(JSON.stringify(connect?.body)).toBe(
      JSON.stringify({
        name: "Amanda Sena",
        baseUrl: "https://ryzeapi.cloud",
        instanceName: "amanda",
        token: "tok",
      }),
    );

    await waitFor(
      () =>
        expect(refreshes > 0 && !!screen.queryByRole("combobox")).toBe(true),
      { timeout: 6_000 },
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "7" } });
    fireEvent.click(
      screen.getByRole("button", { name: /^(Finish|Concluir)$/ }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes("/api/v1/chatwoot/inboxes/41") &&
            JSON.stringify(c.body) === JSON.stringify({ agentId: "7" }),
        ),
      ).toBe(true),
    );
  }, 15_000);
});
