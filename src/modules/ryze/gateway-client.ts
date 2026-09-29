import type { RyzeGateway } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import { createRyzeClient, type RyzeClient } from "./client";

// The RyzeAPI client of a stored gateway, behind one swappable factory so the emulator, the label
// sync and their tests reach the same fake.

async function defaultRyzeClient(gw: RyzeGateway): Promise<RyzeClient> {
  return createRyzeClient({
    baseUrl: gw.baseUrl,
    instance: gw.instanceName,
    token: decryptJson<string>(gw.token),
  });
}

let ryzeClientFactory: (gw: RyzeGateway) => Promise<RyzeClient> =
  defaultRyzeClient;

export function ryzeClientForGateway(gw: RyzeGateway): Promise<RyzeClient> {
  return ryzeClientFactory(gw);
}

// NOTE: test seam; returns the previous factory.
export function setRyzeClientFactory(
  next: (gw: RyzeGateway) => Promise<RyzeClient>,
): (gw: RyzeGateway) => Promise<RyzeClient> {
  const prev = ryzeClientFactory;
  ryzeClientFactory = next;
  return prev;
}
