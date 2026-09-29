import { AlertTriangle, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  FormField,
  Input,
  Modal,
  type ModalController,
  Select,
  Skeleton,
  Textarea,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { cn } from "@/client/lib/utils";
import {
  labelSlug,
  RYZE_LABEL_COLORS,
  RYZE_LABEL_DESCRIPTION_MAX,
  RYZE_LABEL_MAX,
  RYZE_LABEL_TITLE_MAX,
  type RyzeLabelAutoRule,
  ryzeLabelColorHex,
} from "@/modules/ryze/label-shared";

// The WhatsApp Business labels of one RyzeAPI number: the catalog (with the ones created on the
// phone), a form to create one, and inline edits of "when to use" and the automatic rule. Label
// colors are WhatsApp's palette, which is data, so they are applied as inline colors.

type CatalogData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.ryze.gateways>["labels"]["get"]>
>["data"];
type Catalog = NonNullable<CatalogData>["catalog"];
type Label = Catalog["labels"][number];

export interface RyzeLabelsTarget {
  instanceId: string;
  name: string;
}

function ColorSwatches({
  value,
  onChange,
}: {
  value: number;
  onChange: (c: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      {RYZE_LABEL_COLORS.map((hex, i) => (
        <button
          key={hex}
          type="button"
          onClick={() => onChange(i)}
          aria-pressed={value === i}
          aria-label={t("channels.ryze.labels.colorN", "Color {{n}}", {
            n: i + 1,
          })}
          className={cn("h-7 w-7 rounded-full border-2 transition-transform", {
            "scale-110 border-text-primary": value === i,
            "border-transparent": value !== i,
          })}
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}

function AutoRuleSelect({
  value,
  onChange,
  id,
}: {
  value: RyzeLabelAutoRule | "";
  onChange: (v: RyzeLabelAutoRule | "") => void;
  id?: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as RyzeLabelAutoRule | "")}
    >
      <option value="">{t("channels.ryze.labels.ruleNone", "None")}</option>
      <option value="clear_on_reply">
        {t(
          "channels.ryze.labels.ruleClearOnReply",
          "Removed when the contact replies",
        )}
      </option>
      <option value="human_takeover">
        {t("channels.ryze.labels.ruleHumanTakeover", "When a human takes over")}
      </option>
      <option value="new_conversation">
        {t("channels.ryze.labels.ruleNewConversation", "New conversation")}
      </option>
    </Select>
  );
}

function ruleText(
  rule: RyzeLabelAutoRule | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (rule === "clear_on_reply")
    return t(
      "channels.ryze.labels.ruleClearOnReply",
      "Removed when the contact replies",
    );
  if (rule === "human_takeover")
    return t(
      "channels.ryze.labels.ruleHumanTakeover",
      "When a human takes over",
    );
  if (rule === "new_conversation")
    return t("channels.ryze.labels.ruleNewConversation", "New conversation");
  return null;
}

function LabelRow({
  label,
  instanceId,
  onSaved,
  onDelete,
}: {
  label: Label;
  instanceId: string;
  onSaved: (l: Label) => void;
  onDelete: (l: Label) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(label.description ?? "");
  const [rule, setRule] = useState<RyzeLabelAutoRule | "">(
    label.autoRule ?? "",
  );
  const [color, setColor] = useState(label.color);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDescription(label.description ?? "");
    setRule(label.autoRule ?? "");
    setColor(label.color);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      const { data, error } = await api.api.v1.ryze
        .gateways({ id: instanceId })
        .labels({ labelId: label.id })
        .patch({
          description: description.trim() || null,
          autoRule: rule || null,
          color,
        });
      if (error || !data) {
        showToast(
          apiErrorMessage(error) ||
            t("channels.ryze.labels.saveError", "Could not save the label."),
          "error",
        );
        return;
      }
      onSaved(data.label);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const rules = ruleText(label.autoRule, t);
  return (
    <li className="flex flex-col gap-2 border-border border-b px-1 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: ryzeLabelColorHex(label.color) }}
              aria-hidden="true"
            />
            <span className="font-medium text-text-primary">
              {label.displayName}
            </span>
            {label.displayName !== label.title ? (
              <span className="font-mono text-text-muted text-xs">
                {label.title}
              </span>
            ) : null}
            {label.origin === "device" ? (
              <Badge variant="info">
                {t("channels.ryze.labels.fromPhone", "created on the phone")}
              </Badge>
            ) : null}
            {rules ? <Badge>{rules}</Badge> : null}
          </div>
          {!editing ? (
            <span className="text-sm text-text-secondary">
              {label.description ||
                t(
                  "channels.ryze.labels.noDescription",
                  "No “when to use” yet: the agent is not told about this label.",
                )}
            </span>
          ) : null}
        </div>
        {!editing ? (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={startEdit}
              aria-label={t("channels.ryze.labels.edit", "Edit label")}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => onDelete(label)}
              aria-label={t("channels.ryze.labels.delete", "Delete label")}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-3">
          <FormField
            label={t("channels.ryze.labels.whenToUse", "When to use")}
            description={t(
              "channels.ryze.labels.whenToUseHint",
              'Shown to the agent. Start with "Etapa:" for a funnel stage: the agent keeps one stage label at a time.',
            )}
          >
            <Textarea
              rows={2}
              value={description}
              maxLength={RYZE_LABEL_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <FormField label={t("channels.ryze.labels.rule", "Automatic rule")}>
            <AutoRuleSelect value={rule} onChange={setRule} />
          </FormField>
          <FormField
            group
            label={t("channels.ryze.labels.color", "Color")}
            description={t(
              "channels.ryze.labels.colorLocalHint",
              "RyzeAPI cannot edit a label, so a new color shows only here, not on the phone.",
            )}
          >
            <ColorSwatches value={color} onChange={setColor} />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              {t("common.cancel", "Cancel")}
            </Button>
            <Button size="sm" onClick={() => void save()} loading={saving}>
              <Check className="h-4 w-4" aria-hidden="true" />
              {t("common.save", "Save")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function LabelsBody({ target }: { target: RyzeLabelsTarget }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const confirm = useModalController<ConfirmPayload>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [color, setColor] = useState(0);
  const [description, setDescription] = useState("");
  const [rule, setRule] = useState<RyzeLabelAutoRule | "">("");
  const [creating, setCreating] = useState(false);
  const session = useRef(0);

  const load = useCallback(async () => {
    const mine = ++session.current;
    setFailed(false);
    try {
      const { data, error } = await api.api.v1.ryze
        .gateways({ id: target.instanceId })
        .labels.get();
      if (mine !== session.current) return;
      if (error || !data) {
        setFailed(true);
        return;
      }
      setCatalog(data.catalog);
    } catch {
      if (mine === session.current) setFailed(true);
    }
  }, [target.instanceId]);

  useEffect(() => {
    setCatalog(null);
    void load();
    return () => {
      session.current += 1;
    };
  }, [load]);

  const count = catalog?.labels.length ?? 0;
  const full = count >= (catalog?.max ?? RYZE_LABEL_MAX);
  const effectiveTitle = titleTouched ? title : labelSlug(displayName);
  const ready =
    !!displayName.trim() && !!effectiveTitle.trim() && !full && !creating;

  async function create() {
    setCreating(true);
    try {
      const { data, error } = await api.api.v1.ryze
        .gateways({ id: target.instanceId })
        .labels.post({
          displayName: displayName.trim(),
          title: effectiveTitle.trim(),
          color,
          description: description.trim() || null,
          autoRule: rule || null,
        });
      if (error || !data) {
        showToast(
          apiErrorMessage(error) ||
            t(
              "channels.ryze.labels.createError",
              "Could not create the label.",
            ),
          "error",
        );
        return;
      }
      setCatalog((prev) =>
        prev ? { ...prev, labels: [...prev.labels, data.label] } : prev,
      );
      setDisplayName("");
      setTitle("");
      setTitleTouched(false);
      setColor(0);
      setDescription("");
      setRule("");
      if (!data.label.tagId) void load();
    } finally {
      setCreating(false);
    }
  }

  function askDelete(label: Label) {
    confirm.open({
      title: t("channels.ryze.labels.deleteTitle", "Delete label"),
      message: t(
        "channels.ryze.labels.deleteMessage",
        "{{name}} is deleted on WhatsApp too and taken off every conversation of this number.",
        { name: label.displayName },
      ),
      danger: true,
      confirmLabel: t("common.remove", "Remove"),
      onConfirm: async () => {
        const { error } = await api.api.v1.ryze
          .gateways({ id: target.instanceId })
          .labels({ labelId: label.id })
          .delete();
        if (error) {
          showToast(
            apiErrorMessage(error) ||
              t(
                "channels.ryze.labels.deleteError",
                "Could not delete the label.",
              ),
            "error",
          );
          throw error;
        }
        setCatalog((prev) =>
          prev
            ? {
                ...prev,
                labels: prev.labels.filter((l) => l.id !== label.id),
              }
            : prev,
        );
      },
    });
  }

  if (failed) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-error text-sm">
          {t("channels.ryze.labels.loadError", "Could not load the labels.")}
        </p>
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          {t("common.retry", "Retry")}
        </Button>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">{t("common.loading", "Loading…")}</span>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {catalog.labelsSupported === false ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-sm text-text-primary">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          {t(
            "channels.ryze.labels.notBusiness",
            "This number is not WhatsApp Business: the labels stay only in fazer.ai.",
          )}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-text-primary">
            {t("channels.ryze.labels.listTitle", "Labels")}
          </h3>
          <span
            className={cn("text-xs", {
              "text-warning": full,
              "text-text-muted": !full,
            })}
          >
            {t("channels.ryze.labels.usage", "{{used}} of {{max}}", {
              used: count,
              max: catalog.max,
            })}
          </span>
        </div>
        {catalog.labels.length === 0 ? (
          <p className="text-sm text-text-muted">
            {t(
              "channels.ryze.labels.empty",
              "No labels yet. Labels created on the phone show up here too.",
            )}
          </p>
        ) : (
          <ul>
            {catalog.labels.map((l) => (
              <LabelRow
                key={l.id}
                label={l}
                instanceId={target.instanceId}
                onSaved={(saved) =>
                  setCatalog((prev) =>
                    prev
                      ? {
                          ...prev,
                          labels: prev.labels.map((x) =>
                            x.id === saved.id ? saved : x,
                          ),
                        }
                      : prev,
                  )
                }
                onDelete={askDelete}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h3 className="font-medium text-text-primary">
          {t("channels.ryze.labels.createTitle", "New label")}
        </h3>
        {full ? (
          <p className="text-sm text-warning">
            {t(
              "channels.ryze.labels.limitReached",
              "WhatsApp Business allows at most {{max}} labels per number. Delete one to create another.",
              { max: catalog.max },
            )}
          </p>
        ) : null}
        <FormField
          label={t("channels.ryze.labels.displayName", "Name on WhatsApp")}
          required
        >
          <Input
            value={displayName}
            maxLength={RYZE_LABEL_TITLE_MAX}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t(
              "channels.ryze.labels.displayNamePlaceholder",
              "e.g. Proposal sent",
            )}
          />
        </FormField>
        <FormField
          label={t(
            "channels.ryze.labels.internalTitle",
            "Internal name (used by the agent)",
          )}
          required
          description={t(
            "channels.ryze.labels.internalTitleHint",
            "The label the agent and its prompt refer to. Filled from the WhatsApp name; you can change it.",
          )}
        >
          <Input
            value={effectiveTitle}
            maxLength={RYZE_LABEL_TITLE_MAX}
            className="font-mono"
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
          />
        </FormField>
        <FormField group label={t("channels.ryze.labels.color", "Color")}>
          <ColorSwatches value={color} onChange={setColor} />
        </FormField>
        <FormField
          label={t("channels.ryze.labels.whenToUse", "When to use")}
          description={t(
            "channels.ryze.labels.whenToUseHint",
            'Shown to the agent. Start with "Etapa:" for a funnel stage: the agent keeps one stage label at a time.',
          )}
        >
          <Textarea
            rows={2}
            value={description}
            maxLength={RYZE_LABEL_DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <FormField label={t("channels.ryze.labels.rule", "Automatic rule")}>
          <AutoRuleSelect value={rule} onChange={setRule} />
        </FormField>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void create()}
            loading={creating}
            disabled={!ready}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("channels.ryze.labels.create", "Create label")}
          </Button>
        </div>
      </div>
      <ConfirmDialog modal={confirm} />
    </div>
  );
}

export function RyzeLabelsModal({
  modal,
}: {
  modal: ModalController<RyzeLabelsTarget>;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(0);
  useOnModalOpen(modal, () => setOpened((n) => n + 1));
  return (
    <Modal
      modal={modal}
      size="lg"
      title={t("channels.ryze.labels.title", "WhatsApp labels")}
      description={modal.payload?.name}
    >
      {modal.payload ? (
        <LabelsBody key={opened} target={modal.payload} />
      ) : null}
    </Modal>
  );
}
