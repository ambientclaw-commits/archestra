"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  Control,
  FieldArrayWithId,
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFieldArrayUpdate,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

type EnvVar = NonNullable<
  McpCatalogFormValues["localConfig"]
>["environment"][number];
type AdditionalHeader = NonNullable<
  McpCatalogFormValues["additionalHeaders"]
>[number];

type FieldFormType = "string" | "secret" | "boolean" | "number";
type SourceKind = "prompt-install" | "static";
type TargetKind = "env-var" | "secret-file" | "header";

const HEADER_NAME_REGEX = /^[A-Za-z0-9-]+$/;

type EnvFieldArray = {
  fields: FieldArrayWithId<McpCatalogFormValues, "localConfig.environment">[];
  append: UseFieldArrayAppend<McpCatalogFormValues, "localConfig.environment">;
  remove: UseFieldArrayRemove;
  update: UseFieldArrayUpdate<McpCatalogFormValues, "localConfig.environment">;
};

type HeaderFieldArray = {
  fields: FieldArrayWithId<McpCatalogFormValues, "additionalHeaders">[];
  append: UseFieldArrayAppend<McpCatalogFormValues, "additionalHeaders">;
  remove: UseFieldArrayRemove;
  update: UseFieldArrayUpdate<McpCatalogFormValues, "additionalHeaders">;
};

interface FieldsAndMappingsSectionProps {
  control: Control<McpCatalogFormValues>;
  form: {
    watch: UseFormWatch<McpCatalogFormValues>;
    setValue: UseFormSetValue<McpCatalogFormValues>;
  };
  envVars: EnvFieldArray;
  headers: HeaderFieldArray;
  /** When true, env-var and secret-file targets are available. */
  allowLocalTargets: boolean;
  /** When true, header target is available. */
  allowHeaderTarget: boolean;
  disablePromptOnInstallation?: boolean;
  disablePromptOnInstallationReason?: string;
}

type Row = {
  id: string;
  origin: "env" | "header";
  index: number;
  key: string;
  type: FieldFormType;
  required: boolean;
  description: string;
  source: SourceKind;
  target: TargetKind;
  targetName: string;
};

export function FieldsAndMappingsSection({
  control: _control,
  form,
  envVars,
  headers,
  allowLocalTargets,
  allowHeaderTarget,
  disablePromptOnInstallation = false,
  disablePromptOnInstallationReason,
}: FieldsAndMappingsSectionProps) {
  const [dialogState, setDialogState] = useState<
    | { mode: "create" }
    | { mode: "edit"; origin: "env" | "header"; index: number }
    | null
  >(null);

  // Subscribe to live form values so the table re-renders on row changes.
  const liveEnv = form.watch("localConfig.environment") ?? [];
  const liveHeaders = form.watch("additionalHeaders") ?? [];

  const rows = useMemo<Row[]>(() => {
    const envRows: Row[] = envVars.fields.map((field, index) => {
      const live = liveEnv[index] ?? (field as unknown as EnvVar);
      const mounted = live.mounted === true;
      return {
        id: field.id,
        origin: "env",
        index,
        key: live.key ?? "",
        type: backendTypeToForm(live.type ?? "plain_text"),
        required: Boolean(live.required),
        description: live.description ?? "",
        source: live.promptOnInstallation ? "prompt-install" : "static",
        target: mounted ? "secret-file" : "env-var",
        targetName: live.key ?? "",
      };
    });
    const headerRows: Row[] = headers.fields.map((field, index) => {
      const live = liveHeaders[index] ?? (field as unknown as AdditionalHeader);
      return {
        id: field.id,
        origin: "header",
        index,
        key: live.headerName ?? "",
        type: "string",
        required: Boolean(live.required),
        description: live.description ?? "",
        source: live.promptOnInstallation ? "prompt-install" : "static",
        target: "header",
        targetName: live.headerName ?? "",
      };
    });
    return [...envRows, ...headerRows];
  }, [envVars.fields, headers.fields, liveEnv, liveHeaders]);

  const editingRow =
    dialogState?.mode === "edit"
      ? (rows.find(
          (r) =>
            r.origin === dialogState.origin && r.index === dialogState.index,
        ) ?? null)
      : null;

  const existingKeys = useMemo(
    () => new Set(rows.map((r) => `${r.target}:${r.key}`)),
    [rows],
  );

  const removeRow = (row: Row) => {
    if (row.origin === "env") {
      envVars.remove(row.index);
    } else {
      headers.remove(row.index);
    }
  };

  const handleSubmit = (values: FieldDialogValues) => {
    const isPrompt = values.source === "prompt-install";
    const value = isPrompt ? "" : values.staticValue;
    const required = values.required;
    const description = values.description.trim() || undefined;

    if (values.target === "header") {
      const payload: AdditionalHeader = {
        fieldName: undefined,
        headerName: values.key.trim(),
        promptOnInstallation: isPrompt,
        required,
        value,
        description,
        includeBearerPrefix: values.includeBearerPrefix,
      };
      if (dialogState?.mode === "edit" && dialogState.origin === "header") {
        headers.update(dialogState.index, payload);
      } else {
        headers.append(payload);
      }
    } else {
      const payload: EnvVar = {
        key: values.key.trim(),
        type: formTypeToBackend(values.type),
        value,
        promptOnInstallation: isPrompt,
        required,
        description,
        mounted: values.target === "secret-file" ? true : undefined,
      };
      if (dialogState?.mode === "edit" && dialogState.origin === "env") {
        envVars.update(dialogState.index, payload);
      } else {
        envVars.append(payload);
      }
    }
    setDialogState(null);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="font-semibold text-base">Fields</h3>
            <p className="text-sm text-muted-foreground">
              What the catalog needs to collect — either prompted at install or
              fixed by the admin.
            </p>
          </div>
          {disablePromptOnInstallation && disablePromptOnInstallationReason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: tabIndex needed so tooltip trigger receives keyboard focus when wrapping a disabled control
                  tabIndex={0}
                  className="cursor-not-allowed"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDialogState({ mode: "create" })}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add field
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">{disablePromptOnInstallationReason}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialogState({ mode: "create" })}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add field
            </Button>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No fields configured.
          </div>
        ) : (
          <div className="rounded-lg border">
            <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_1fr_2fr_auto] gap-2 p-3 bg-muted/50 border-b text-xs font-medium">
              <div>Key</div>
              <div>Type</div>
              <div>Required</div>
              <div>Source</div>
              <div>Description</div>
              <div className="w-20" />
            </div>
            {rows.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[1.4fr_0.7fr_0.7fr_1fr_2fr_auto] gap-2 p-3 items-center border-b last:border-b-0"
              >
                <div className="font-mono text-xs">{row.key || "—"}</div>
                <div className="text-xs">{row.type}</div>
                <div className="text-xs">
                  {row.required ? (
                    "required"
                  ) : (
                    <span className="text-muted-foreground">optional</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {row.source}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {row.description || "—"}
                </div>
                <div className="flex items-center gap-1 w-20 justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setDialogState({
                        mode: "edit",
                        origin: row.origin,
                        index: row.index,
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-base">Mappings</h3>
          <p className="text-sm text-muted-foreground">
            How field values are projected onto env vars, headers, or secret
            files at runtime.
          </p>
        </div>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No mappings yet.
          </div>
        ) : (
          <div className="rounded-lg border">
            <div className="grid grid-cols-[1.5fr_120px_1.5fr] gap-2 p-3 bg-muted/50 border-b text-xs font-medium">
              <div>Source</div>
              <div>Target</div>
              <div>Name</div>
            </div>
            {rows.map((row) => (
              <div
                key={`${row.id}-mapping`}
                className="grid grid-cols-[1.5fr_120px_1.5fr] gap-2 p-3 items-center border-b last:border-b-0 text-xs"
              >
                <div className="font-mono">
                  <span className="text-muted-foreground">field </span>
                  {row.key || "—"}
                </div>
                <div>
                  <Badge variant="outline" className="text-[10px]">
                    {row.target}
                  </Badge>
                </div>
                <div className="font-mono">{row.targetName || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <FieldDialog
        open={dialogState !== null}
        onOpenChange={(open) => {
          if (!open) setDialogState(null);
        }}
        mode={dialogState?.mode ?? "create"}
        existing={editingRow}
        existingKeys={existingKeys}
        allowLocalTargets={allowLocalTargets}
        allowHeaderTarget={allowHeaderTarget}
        disablePromptOnInstallation={disablePromptOnInstallation}
        disablePromptOnInstallationReason={disablePromptOnInstallationReason}
        onSubmit={handleSubmit}
        existingValue={
          editingRow
            ? readStaticValue({
                row: editingRow,
                liveEnv,
                liveHeaders,
              })
            : ""
        }
        existingIncludeBearerPrefix={
          editingRow?.origin === "header"
            ? Boolean(liveHeaders[editingRow.index]?.includeBearerPrefix)
            : false
        }
      />
    </div>
  );
}

type FieldDialogValues = {
  key: string;
  type: FieldFormType;
  required: boolean;
  description: string;
  source: SourceKind;
  staticValue: string;
  target: TargetKind;
  includeBearerPrefix: boolean;
};

function FieldDialog({
  open,
  onOpenChange,
  mode,
  existing,
  existingValue,
  existingIncludeBearerPrefix,
  existingKeys,
  allowLocalTargets,
  allowHeaderTarget,
  disablePromptOnInstallation,
  disablePromptOnInstallationReason,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "create" | "edit";
  existing: Row | null;
  existingValue: string;
  existingIncludeBearerPrefix: boolean;
  existingKeys: Set<string>;
  allowLocalTargets: boolean;
  allowHeaderTarget: boolean;
  disablePromptOnInstallation?: boolean;
  disablePromptOnInstallationReason?: string;
  onSubmit: (values: FieldDialogValues) => void;
}) {
  const defaultTarget: TargetKind = allowLocalTargets
    ? "env-var"
    : allowHeaderTarget
      ? "header"
      : "env-var";

  const [key, setKey] = useState("");
  const [type, setType] = useState<FieldFormType>("string");
  const [required, setRequired] = useState(true);
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<SourceKind>("prompt-install");
  const [staticValue, setStaticValue] = useState("");
  const [target, setTarget] = useState<TargetKind>(defaultTarget);
  const [includeBearerPrefix, setIncludeBearerPrefix] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setKey(existing.key);
      setType(existing.type);
      setRequired(existing.required);
      setDescription(existing.description);
      setSource(existing.source);
      setStaticValue(existingValue);
      setTarget(existing.target);
      setIncludeBearerPrefix(existingIncludeBearerPrefix);
    } else {
      setKey("");
      setType("string");
      setRequired(true);
      setDescription("");
      setSource(disablePromptOnInstallation ? "static" : "prompt-install");
      setStaticValue("");
      setTarget(defaultTarget);
      setIncludeBearerPrefix(false);
    }
  }, [
    open,
    existing,
    existingValue,
    existingIncludeBearerPrefix,
    defaultTarget,
    disablePromptOnInstallation,
  ]);

  const trimmedKey = key.trim();
  const conflictKey = `${target}:${trimmedKey}`;
  const conflict =
    trimmedKey.length > 0 &&
    existingKeys.has(conflictKey) &&
    !(existing && `${existing.target}:${existing.key}` === conflictKey);

  const headerNameInvalid =
    target === "header" &&
    trimmedKey.length > 0 &&
    !HEADER_NAME_REGEX.test(trimmedKey);

  const canSubmit =
    trimmedKey.length > 0 &&
    !conflict &&
    !headerNameInvalid &&
    (source !== "static" || staticValue.length > 0);

  const promptDisabledNote =
    disablePromptOnInstallation && disablePromptOnInstallationReason
      ? disablePromptOnInstallationReason
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>
            {mode === "edit" ? "Edit field" : "Add field"}
          </DialogTitle>
          <DialogDescription>
            Define one input. Choose where the value comes from and where it's
            mapped at runtime.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="field-target">Map to</Label>
            <Select
              value={target}
              onValueChange={(v) => setTarget(v as TargetKind)}
            >
              <SelectTrigger id="field-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowLocalTargets && (
                  <SelectItem value="env-var">env-var</SelectItem>
                )}
                {allowLocalTargets && (
                  <SelectItem value="secret-file">secret-file</SelectItem>
                )}
                {allowHeaderTarget && (
                  <SelectItem value="header">header</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="field-key">
              {target === "header" ? "Header name" : "Key"}
            </Label>
            <Input
              id="field-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                target === "header"
                  ? "x-api-key"
                  : target === "secret-file"
                    ? "tls-cert"
                    : "API_KEY"
              }
              className="font-mono text-xs"
            />
            {conflict && (
              <p className="text-xs text-destructive">
                A {target} with this name already exists.
              </p>
            )}
            {headerNameInvalid && (
              <p className="text-xs text-destructive">
                Header name must contain only letters, digits, and hyphens.
              </p>
            )}
          </div>

          {target !== "header" && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="field-type">Type</Label>
                <Select
                  value={type}
                  onValueChange={(v) => setType(v as FieldFormType)}
                >
                  <SelectTrigger id="field-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">string</SelectItem>
                    <SelectItem value="secret">secret</SelectItem>
                    <SelectItem value="boolean">boolean</SelectItem>
                    <SelectItem value="number">number</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="block">&nbsp;</Label>
                <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
                  <Checkbox
                    checked={required}
                    onCheckedChange={(v) => setRequired(v === true)}
                    disabled={source !== "prompt-install"}
                  />
                  <span className="text-sm">Required</span>
                </Label>
              </div>
            </div>
          )}

          {target === "header" && (
            <div className="space-y-2">
              <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
                <Checkbox
                  checked={required}
                  onCheckedChange={(v) => setRequired(v === true)}
                  disabled={source !== "prompt-install"}
                />
                <span className="text-sm">Required</span>
              </Label>
              <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
                <Checkbox
                  checked={includeBearerPrefix}
                  onCheckedChange={(v) => setIncludeBearerPrefix(v === true)}
                />
                <span className="text-sm">Include Bearer prefix</span>
              </Label>
            </div>
          )}

          <div className="space-y-2">
            <Label>Source</Label>
            <RadioGroup
              value={source}
              onValueChange={(v) => setSource(v as SourceKind)}
              className="grid gap-2"
            >
              <Label
                htmlFor="src-prompt"
                className={`flex items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary ${
                  promptDisabledNote
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer"
                }`}
              >
                <RadioGroupItem
                  value="prompt-install"
                  id="src-prompt"
                  className="mt-0.5"
                  disabled={Boolean(promptDisabledNote)}
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Prompt at install</div>
                  <div className="text-xs text-muted-foreground">
                    {promptDisabledNote ??
                      "User enters the value once during install."}
                  </div>
                </div>
              </Label>
              <Label
                htmlFor="src-static"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem
                  value="static"
                  id="src-static"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Static</div>
                  <div className="text-xs text-muted-foreground">
                    Fixed at the catalog level.
                  </div>
                </div>
              </Label>
            </RadioGroup>
          </div>

          {source === "static" && (
            <div className="space-y-2">
              <Label htmlFor="field-static-value">Value</Label>
              <Input
                id="field-static-value"
                value={staticValue}
                onChange={(e) => setStaticValue(e.target.value)}
                placeholder="value"
                className="font-mono text-xs"
                type={type === "secret" ? "password" : "text"}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="field-desc">Description</Label>
            <Textarea
              id="field-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this for?"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() =>
              onSubmit({
                key: trimmedKey,
                type,
                required,
                description,
                source,
                staticValue,
                target,
                includeBearerPrefix,
              })
            }
            disabled={!canSubmit}
          >
            {mode === "edit" ? "Save" : "Add field"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function backendTypeToForm(
  type: "plain_text" | "secret" | "boolean" | "number",
): FieldFormType {
  return type === "plain_text" ? "string" : type;
}

function formTypeToBackend(
  type: FieldFormType,
): "plain_text" | "secret" | "boolean" | "number" {
  return type === "string" ? "plain_text" : type;
}

function readStaticValue({
  row,
  liveEnv,
  liveHeaders,
}: {
  row: Row;
  liveEnv: EnvVar[];
  liveHeaders: AdditionalHeader[];
}): string {
  if (row.source === "prompt-install") return "";
  if (row.origin === "env") return liveEnv[row.index]?.value ?? "";
  return liveHeaders[row.index]?.value ?? "";
}
