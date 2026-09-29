import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  Plus,
  QrCode,
  RefreshCw,
  Tag,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  Select,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { isValidHttpUrl } from "@/client/lib/validation";
import { RyzeLabelsModal, type RyzeLabelsTarget } from "./RyzeLabelsModal";

// The RyzeAPI half of the Channels screen: WhatsApp numbers served through RyzeAPI instead of
// Chatwoot. Connecting is one modal in three steps (credentials, pairing by QR or code, the agent that
// answers); the list shows each number's connection and lets the operator re-pair, refresh or remove
// it. The answering-agent picker is the page's own, passed in, so both lists bind the same way.

type GatewaysData = Awaited<
  ReturnType<typeof api.api.v1.ryze.gateways.get>
>["data"];
export type RyzeGateway = NonNullable<GatewaysData>["gateways"][number];

interface AgentOption {
  id: string;
  name: string;
}

type Step = "form" | "pair" | "agent";

const DEFAULT_BASE_URL = "https://ryzeapi.cloud";
const STATUS_POLL_MS = 3_000;
const QR_REFRESH_MS = 25_000;

function StateBadge({ state }: { state: string | null }) {
  const { t } = useTranslation();
  if (state === "connected") {
    return (
      <Badge variant="success">
        {t("channels.ryze.stateConnected", "Connected")}
      </Badge>
    );
  }
  if (state === "connecting") {
    return (
      <Badge variant="info">
        {t("channels.ryze.stateConnecting", "Connecting")}
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      {t("channels.ryze.stateDisconnected", "Not paired")}
    </Badge>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RyzeSection({
  agents,
  renderAgentPicker,
  onChanged,
  onInboxes,
}: {
  agents: AgentOption[];
  renderAgentPicker: (
    inboxId: string,
    agentId: string | null,
    onBound: () => void,
  ) => ReactNode;
  onChanged: () => void;
  onInboxes?: (inboxDbIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [gateways, setGateways] = useState<RyzeGateway[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const modal = useModalController();
  const confirm = useModalController<ConfirmPayload>();
  const labelsModal = useModalController<RyzeLabelsTarget>();
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [instanceName, setInstanceName] = useState("");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [current, setCurrent] = useState<RyzeGateway | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [usePhone, setUsePhone] = useState(false);
  const [phoneSubmitted, setPhoneSubmitted] = useState(false);
  // The phone is read when the operator submits it, so typing does not restart the pairing loop.
  const phoneRef = useRef("");
  const [pairError, setPairError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [binding, setBinding] = useState(false);
  const session = useRef(0);

  const load = useCallback(async () => {
    try {
      const { data } = await api.api.v1.ryze.gateways.get();
      if (data) {
        setGateways(data.gateways);
        onInboxes?.(
          data.gateways
            .map((g) => g.inboxDbId)
            .filter((id): id is string => id !== null),
        );
      }
    } finally {
      setLoaded(true);
    }
  }, [onInboxes]);

  useEffect(() => {
    void load();
  }, [load]);

  function openConnect() {
    session.current += 1;
    setStep("form");
    setName("");
    setBaseUrl(DEFAULT_BASE_URL);
    setInstanceName("");
    setToken("");
    setCurrent(null);
    setQr(null);
    setPairingCode(null);
    setPhone("");
    phoneRef.current = "";
    setUsePhone(false);
    setPhoneSubmitted(false);
    setPairError(null);
    setAgentId("");
    modal.open();
  }

  function openPair(gw: RyzeGateway) {
    session.current += 1;
    setCurrent(gw);
    setQr(null);
    setPairingCode(null);
    setPairError(null);
    setUsePhone(false);
    setPhoneSubmitted(false);
    setPhone("");
    phoneRef.current = "";
    setAgentId(gw.agentId ?? "");
    setStep(gw.connectionState === "connected" ? "agent" : "pair");
    modal.open();
  }

  function closeModal() {
    session.current += 1;
    modal.close();
    void load();
    onChanged();
  }

  async function connect() {
    setConnecting(true);
    try {
      const { data, error } = await api.api.v1.ryze.gateways.post({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        instanceName: instanceName.trim(),
        token: token.trim(),
      });
      if (error || !data) {
        showToast(
          apiErrorMessage(error) ||
            t(
              "channels.ryze.connectError",
              "Could not connect. Check the instance name and token.",
            ),
          "error",
        );
        return;
      }
      setCurrent(data.gateway);
      void load();
      setStep(data.gateway.connectionState === "connected" ? "agent" : "pair");
    } catch {
      showToast(
        t(
          "channels.ryze.connectError",
          "Could not connect. Check the instance name and token.",
        ),
        "error",
      );
    } finally {
      setConnecting(false);
    }
  }

  // Pairing loop: ask RyzeAPI for a code, then watch the connection until the phone links or the QR
  // expires, and ask again. A new session (modal closed, step changed, another number) ends it.
  useEffect(() => {
    if (!modal.isOpen || step !== "pair" || !current) return;
    if (usePhone && !phoneSubmitted) return;
    const mine = ++session.current;
    const id = current.instanceId;
    const alive = () => session.current === mine;
    void (async () => {
      while (alive()) {
        setPairError(null);
        try {
          const { data, error } = await api.api.v1.ryze
            .gateways({ id })
            .pair.post(usePhone ? { number: phoneRef.current } : {});
          if (!alive()) return;
          if (error || !data) {
            setPairError(
              apiErrorMessage(error) ||
                t("channels.ryze.pairError", "Could not get a pairing code."),
            );
            await wait(QR_REFRESH_MS);
            continue;
          }
          if (data.pairing.connected) {
            setStep("agent");
            return;
          }
          setQr(data.pairing.qrCodeBase64);
          setPairingCode(data.pairing.pairingCode);
        } catch {
          if (!alive()) return;
          setPairError(
            t("channels.ryze.pairError", "Could not get a pairing code."),
          );
        }
        const until = Date.now() + QR_REFRESH_MS;
        while (alive() && Date.now() < until) {
          await wait(STATUS_POLL_MS);
          if (!alive()) return;
          try {
            const { data } = await api.api.v1.ryze
              .gateways({ id })
              .refresh.post();
            if (data?.gateway.connectionState === "connected") {
              if (alive()) setStep("agent");
              return;
            }
          } catch {
            // NOTE: a missed status read is retried on the next tick.
          }
        }
      }
    })();
    return () => {
      session.current += 1;
    };
  }, [modal.isOpen, step, current, usePhone, phoneSubmitted, t]);

  async function bindAgent() {
    if (!current?.inboxDbId) {
      closeModal();
      return;
    }
    setBinding(true);
    try {
      const { error } = await api.api.v1.chatwoot
        .inboxes({ id: current.inboxDbId })
        .patch({ agentId: agentId || null });
      if (error) {
        showToast(
          apiErrorMessage(error) ||
            t("channels.bindError", "Could not update the inbox."),
          "error",
        );
        return;
      }
      showToast(t("channels.ryze.ready", "WhatsApp number ready."), "success");
      closeModal();
    } finally {
      setBinding(false);
    }
  }

  async function refresh(gw: RyzeGateway) {
    setBusyId(gw.instanceId);
    try {
      const { data, error } = await api.api.v1.ryze
        .gateways({ id: gw.instanceId })
        .refresh.post();
      if (error || !data) {
        showToast(
          apiErrorMessage(error) ||
            t("channels.ryze.refreshError", "Could not read the connection."),
          "error",
        );
        return;
      }
      setGateways((prev) =>
        prev.map((g) =>
          g.instanceId === gw.instanceId
            ? {
                ...g,
                ...data.gateway,
                inboxDbId: g.inboxDbId,
                agentId: g.agentId,
              }
            : g,
        ),
      );
    } finally {
      setBusyId(null);
    }
  }

  function askRemove(gw: RyzeGateway) {
    confirm.open({
      title: t("channels.ryze.removeTitle", "Remove WhatsApp number"),
      message: t(
        "channels.ryze.removeMessage",
        "{{name}} stops being answered here and its conversations are deleted. The number stays paired on RyzeAPI.",
        { name: gw.name },
      ),
      danger: true,
      confirmLabel: t("common.remove", "Remove"),
      onConfirm: async () => {
        const { error } = await api.api.v1.ryze
          .gateways({ id: gw.instanceId })
          .delete();
        if (error) {
          showToast(
            apiErrorMessage(error) ||
              t("channels.ryze.removeError", "Could not remove the number."),
            "error",
          );
          throw error;
        }
        setGateways((prev) =>
          prev.filter((g) => g.instanceId !== gw.instanceId),
        );
        onChanged();
      },
    });
  }

  const baseUrlInvalid = !!baseUrl.trim() && !isValidHttpUrl(baseUrl.trim());
  const formReady =
    !!name.trim() &&
    !!baseUrl.trim() &&
    !baseUrlInvalid &&
    !!instanceName.trim() &&
    !!token.trim();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium text-text-primary">
          <MessageCircle className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("channels.ryze.title", "WhatsApp via RyzeAPI")}
        </h2>
        {gateways.length > 0 ? (
          <Button size="sm" onClick={openConnect}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("channels.ryze.add", "Connect number")}
          </Button>
        ) : null}
      </div>

      {loaded && gateways.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            icon={MessageCircle}
            title={t("channels.ryze.emptyTitle", "No WhatsApp number yet")}
            description={t(
              "channels.ryze.emptyDescription",
              "Connect a number from RyzeAPI with its instance name and token. You scan a QR code here and choose the agent that answers.",
            )}
            action={
              <Button onClick={openConnect}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("channels.ryze.add", "Connect number")}
              </Button>
            }
          />
        </Card>
      ) : null}

      {gateways.length > 0 ? (
        <Card className="p-0">
          <ul>
            {gateways.map((gw) => (
              <li
                key={gw.instanceId}
                className="flex flex-wrap items-center justify-between gap-4 border-border border-b px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-text-primary">
                      {gw.name}
                    </span>
                    <StateBadge state={gw.connectionState} />
                  </div>
                  <span className="truncate text-text-muted text-xs">
                    {gw.numberJid
                      ? `+${gw.numberJid.split("@")[0]} · ${gw.instanceName}`
                      : gw.instanceName}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {gw.inboxDbId
                    ? renderAgentPicker(
                        gw.inboxDbId,
                        gw.agentId,
                        () => void load(),
                      )
                    : null}
                  {gw.connectionState !== "connected" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openPair(gw)}
                    >
                      <QrCode className="h-4 w-4" aria-hidden="true" />
                      {t("channels.ryze.pair", "Pair")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      labelsModal.open({
                        instanceId: gw.instanceId,
                        name: gw.name,
                      })
                    }
                  >
                    <Tag className="h-4 w-4" aria-hidden="true" />
                    {t("channels.ryze.labels.open", "WhatsApp labels")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busyId === gw.instanceId}
                    onClick={() => void refresh(gw)}
                    aria-label={t("channels.ryze.refresh", "Refresh status")}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => askRemove(gw)}
                    aria-label={t("channels.ryze.remove", "Remove number")}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Modal
        modal={modal}
        title={
          step === "form"
            ? t("channels.ryze.connectTitle", "Connect a WhatsApp number")
            : step === "pair"
              ? t("channels.ryze.pairTitle", "Pair the number")
              : t("channels.ryze.agentTitle", "Who answers this number?")
        }
        closeOnOutsideClick={false}
        onCloseRequest={closeModal}
        footer={
          step === "form" ? (
            <div className="flex justify-end gap-2">
              <ModalCancelButton disabled={connecting} />
              <Button
                onClick={() => void connect()}
                loading={connecting}
                disabled={!formReady}
              >
                {t("channels.ryze.next", "Continue")}
              </Button>
            </div>
          ) : step === "pair" ? (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeModal}>
                {t("channels.ryze.later", "Pair later")}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeModal}>
                {t("channels.ryze.skipAgent", "Choose later")}
              </Button>
              <Button
                onClick={() => void bindAgent()}
                loading={binding}
                disabled={!agentId}
              >
                {t("channels.ryze.finish", "Finish")}
              </Button>
            </div>
          )
        }
      >
        {step === "form" ? (
          <div className="flex flex-col gap-4">
            <FormField
              label={t("channels.ryze.name", "Name")}
              required
              description={t(
                "channels.ryze.nameHint",
                "How this number appears here, e.g. the business name.",
              )}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("channels.ryze.namePlaceholder", "My business")}
              />
            </FormField>
            <FormField
              label={t("channels.ryze.instance", "Instance name")}
              required
              description={t(
                "channels.ryze.instanceHint",
                "The instance name shown in your RyzeAPI dashboard.",
              )}
            >
              <Input
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
              />
            </FormField>
            <FormField
              label={t("channels.ryze.token", "Instance token")}
              required
              description={t(
                "channels.ryze.tokenHint",
                "The instance token from RyzeAPI. It is stored encrypted and never shown again.",
              )}
            >
              <Input
                type="password"
                showPasswordToggle
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </FormField>
            <FormField
              label={t("channels.ryze.baseUrl", "RyzeAPI URL")}
              error={
                baseUrlInvalid
                  ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                  : null
              }
            >
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </FormField>
          </div>
        ) : step === "pair" ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-text-secondary">
              {usePhone
                ? t(
                    "channels.ryze.pairCodeHelp",
                    "On the phone, open WhatsApp > Linked devices > Link a device > Link with phone number, and type this code.",
                  )
                : t(
                    "channels.ryze.pairQrHelp",
                    "On the phone, open WhatsApp > Linked devices > Link a device, and scan this code.",
                  )}
            </p>
            {!usePhone ? (
              qr ? (
                <img
                  src={qr}
                  alt={t("channels.ryze.qrAlt", "WhatsApp pairing QR code")}
                  className="h-64 w-64 rounded-lg bg-white p-2"
                />
              ) : (
                <div className="flex h-64 w-64 items-center justify-center rounded-lg border border-border">
                  <Loader2
                    className="h-6 w-6 animate-spin text-text-muted"
                    aria-hidden="true"
                  />
                </div>
              )
            ) : pairingCode ? (
              <div className="rounded-lg border border-border px-6 py-4 font-mono text-2xl text-text-primary tracking-widest">
                {pairingCode}
              </div>
            ) : (
              <div className="flex w-full flex-col gap-2">
                <FormField
                  label={t(
                    "channels.ryze.phone",
                    "Phone number of the WhatsApp",
                  )}
                  description={t(
                    "channels.ryze.phoneHint",
                    "With country and area code, digits only, e.g. 5581999999999.",
                  )}
                >
                  <Input
                    value={phone}
                    inputMode="numeric"
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "");
                      phoneRef.current = digits;
                      setPhone(digits);
                    }}
                  />
                </FormField>
                <Button
                  onClick={() => setPhoneSubmitted(true)}
                  disabled={phone.length < 10 || phoneSubmitted}
                  loading={phoneSubmitted}
                >
                  {t("channels.ryze.getCode", "Get code")}
                </Button>
              </div>
            )}
            {pairError ? (
              <p className="text-error text-sm">{pairError}</p>
            ) : (
              <p className="flex items-center gap-2 text-text-muted text-xs">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t(
                  "channels.ryze.waiting",
                  "Waiting for the phone. This step moves on by itself.",
                )}
              </p>
            )}
            <button
              type="button"
              className="text-accent text-sm underline-offset-2 hover:underline"
              onClick={() => {
                setQr(null);
                setPairingCode(null);
                setPhoneSubmitted(false);
                setUsePhone((v) => !v);
              }}
            >
              {usePhone
                ? t("channels.ryze.useQr", "Scan a QR code instead")
                : t("channels.ryze.usePhone", "Can't scan? Use a code instead")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {t("channels.ryze.paired", "The number is connected.")}
            </p>
            <FormField
              label={t("channels.bindLabel", "Answering agent")}
              description={t(
                "channels.ryze.agentHint",
                "The agent starts in the mode it is in now; a test-mode agent only answers conversations started with /teste.",
              )}
            >
              <Select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">
                  {t("channels.ryze.pickAgent", "Choose an agent")}
                </option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        )}
      </Modal>
      <ConfirmDialog modal={confirm} />
      <RyzeLabelsModal modal={labelsModal} />
    </section>
  );
}
