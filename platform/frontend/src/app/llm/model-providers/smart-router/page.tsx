"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFeature } from "@/lib/config/config.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  type LlmRouter,
  useCreateLlmRouter,
  useDeleteLlmRouter,
  useLlmRouters,
  useUpdateLlmRouter,
} from "@/lib/llm-router.query";

type RouterMode = "cost" | "balanced" | "quality";

const MODES: { value: RouterMode; label: string; hint: string }[] = [
  {
    value: "cost",
    label: "Cost",
    hint: "Favor the everyday model; route to premium only for hard requests.",
  },
  { value: "balanced", label: "Balanced", hint: "Split by difficulty." },
  {
    value: "quality",
    label: "Quality",
    hint: "Favor the premium model; route down only for clearly simple requests.",
  },
];

type FormState = {
  name: string;
  apiKeyId: string;
  cheapModelId: string;
  premiumModelId: string;
  mode: RouterMode;
  enabled: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  apiKeyId: "",
  cheapModelId: "",
  premiumModelId: "",
  mode: "balanced",
  enabled: true,
};

export default function SmartRouterPage() {
  const smartRouterEnabled = useFeature("smartRouterEnabled");
  const { data: routers = [], isLoading } = useLlmRouters();
  const deleteRouter = useDeleteLlmRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LlmRouter | null>(null);

  if (smartRouterEnabled === false) {
    return null;
  }

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (router: LlmRouter) => {
    setEditing(router);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          New smart router
        </Button>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : routers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No smart routers yet</CardTitle>
            <CardDescription>
              Create one to route chat requests between an everyday and a
              premium model by difficulty.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {routers.map((router) => (
            <Card key={router.id}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {router.name}
                    {!router.enabled && (
                      <span className="text-muted-foreground text-xs font-normal">
                        (disabled)
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-1 capitalize">
                    {router.mode} mode
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openEdit(router)}
                    aria-label="Edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteRouter.mutate(router.id)}
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <SmartRouterDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
}

function SmartRouterDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: LlmRouter | null;
}) {
  const { data: apiKeys = [] } = useAvailableLlmProviderApiKeys();
  const createRouter = useCreateLlmRouter();
  const updateRouter = useUpdateLlmRouter();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Re-seed the form whenever the dialog opens for a (different) router.
  useEffect(() => {
    if (!open) return;
    setForm(
      editing
        ? {
            name: editing.name,
            apiKeyId: editing.cheapApiKeyId ?? editing.premiumApiKeyId ?? "",
            cheapModelId: editing.cheapModelId ?? "",
            premiumModelId: editing.premiumModelId ?? "",
            mode: editing.mode as RouterMode,
            enabled: editing.enabled,
          }
        : EMPTY_FORM,
    );
  }, [open, editing]);

  const { data: models = [] } = useLlmModels(
    form.apiKeyId ? { apiKeyId: form.apiKeyId } : undefined,
  );
  const chatModels = useMemo(
    () => models.filter((model) => !model.embeddingDimensions),
    [models],
  );

  const canSubmit =
    form.name.trim() &&
    form.apiKeyId &&
    form.cheapModelId &&
    form.premiumModelId &&
    form.cheapModelId !== form.premiumModelId;

  const handleSubmit = async () => {
    const payload = {
      name: form.name.trim(),
      enabled: form.enabled,
      mode: form.mode,
      cheapModelId: form.cheapModelId,
      cheapApiKeyId: form.apiKeyId,
      premiumModelId: form.premiumModelId,
      premiumApiKeyId: form.apiKeyId,
    };
    const result = editing
      ? await updateRouter.mutateAsync({ id: editing.id, ...payload })
      : await createRouter.mutateAsync(payload);
    if (result) {
      onOpenChange(false);
    }
  };

  const update = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit smart router" : "New smart router"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="router-name">Name</Label>
            <Input
              id="router-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="Org cost router"
            />
          </div>

          <div className="space-y-2">
            <Label>Provider API key</Label>
            <Select
              value={form.apiKeyId}
              onValueChange={(value) =>
                update({
                  apiKeyId: value,
                  cheapModelId: "",
                  premiumModelId: "",
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a key" />
              </SelectTrigger>
              <SelectContent>
                {apiKeys.map((key) => (
                  <SelectItem key={key.id} value={key.id}>
                    {key.name} ({key.provider})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Everyday model</Label>
            <Select
              value={form.cheapModelId}
              onValueChange={(value) => update({ cheapModelId: value })}
              disabled={!form.apiKeyId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select the cheaper model" />
              </SelectTrigger>
              <SelectContent>
                {chatModels.map((model) => (
                  <SelectItem key={model.dbId} value={model.dbId}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Premium model</Label>
            <Select
              value={form.premiumModelId}
              onValueChange={(value) => update({ premiumModelId: value })}
              disabled={!form.apiKeyId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select the premium model" />
              </SelectTrigger>
              <SelectContent>
                {chatModels.map((model) => (
                  <SelectItem key={model.dbId} value={model.dbId}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Mode</Label>
            <RadioGroup
              value={form.mode}
              onValueChange={(value) => update({ mode: value as RouterMode })}
              className="gap-2"
            >
              {MODES.map((mode) => (
                <Label
                  key={mode.value}
                  htmlFor={`mode-${mode.value}`}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
                >
                  <RadioGroupItem
                    id={`mode-${mode.value}`}
                    value={mode.value}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{mode.label}</span>
                    <span className="text-muted-foreground block text-xs">
                      {mode.hint}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="router-enabled">Enabled</Label>
            <Switch
              id="router-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !canSubmit || createRouter.isPending || updateRouter.isPending
            }
          >
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
