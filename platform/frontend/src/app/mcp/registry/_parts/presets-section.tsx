import { Plus, Trash2 } from "lucide-react";
import { type Control, useFieldArray, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { getAdditionalHeaderFieldName } from "./mcp-catalog-form.utils";

type PresetValuePrimitive = string | number | boolean | string[];

type PromptedField = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret";
  description?: string;
};

interface PresetsSectionProps {
  control: Control<McpCatalogFormValues>;
  form: UseFormReturn<McpCatalogFormValues>;
}

export function PresetsSection({ control, form }: PresetsSectionProps) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "presets",
  });
  const promptedFields = usePromptedFields(form);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-base">Presets</h3>
            {fields.length > 0 && (
              <span className="text-xs bg-muted px-1.5 py-0.5 rounded-full">
                {fields.length}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Pre-filled values users can pick from when installing this server.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ name: "", description: "", values: {} })}
          disabled={promptedFields.length === 0}
        >
          <Plus className="h-4 w-4" />
          Add preset
        </Button>
      </div>

      {promptedFields.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          Mark at least one environment variable or header as
          "prompt on installation" above to enable presets.
        </p>
      ) : (
        fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <PresetCard
                key={field.id}
                control={control}
                form={form}
                index={index}
                promptedFields={promptedFields}
                onRemove={() => remove(index)}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

interface PresetCardProps {
  control: Control<McpCatalogFormValues>;
  form: UseFormReturn<McpCatalogFormValues>;
  index: number;
  promptedFields: PromptedField[];
  onRemove: () => void;
}

function PresetCard({
  control,
  form,
  index,
  promptedFields,
  onRemove,
}: PresetCardProps) {
  const values = (form.watch(`presets.${index}.values`) ?? {}) as Record<
    string,
    PresetValuePrimitive
  >;

  const setFieldValue = (key: string, next: PresetValuePrimitive | null) => {
    const updated = { ...values };
    if (next === null || next === "") {
      delete updated[key];
    } else {
      updated[key] = next;
    }
    form.setValue(`presets.${index}.values`, updated, {
      shouldDirty: true,
      shouldValidate: false,
    });
  };

  return (
    <div className="rounded-md border p-4 space-y-4">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <FormField
          control={control}
          name={`presets.${index}.name`}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Name</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Studio 1" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="self-end text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Remove preset"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <FormField
        control={control}
        name={`presets.${index}.description`}
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs">Description</FormLabel>
            <FormControl>
              <Input
                placeholder="Optional"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="space-y-3">
        <span className="text-xs font-medium">Values</span>
        {promptedFields.map((pf) => (
          <PresetFieldInput
            key={pf.key}
            field={pf}
            value={values[pf.key]}
            onChange={(next) => setFieldValue(pf.key, next)}
          />
        ))}
      </div>
    </div>
  );
}

interface PresetFieldInputProps {
  field: PromptedField;
  value: PresetValuePrimitive | undefined;
  onChange: (next: PresetValuePrimitive | null) => void;
}

function PresetFieldInput({ field, value, onChange }: PresetFieldInputProps) {
  const id = `preset-field-${field.key}`;

  if (field.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={value === true || value === "true"}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label htmlFor={id} className="text-xs cursor-pointer">
          {field.label}
          <span className="ml-2 font-mono text-muted-foreground">
            {field.key}
          </span>
        </Label>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-3">
      <Label htmlFor={id} className="text-xs">
        <span>{field.label}</span>
        {field.label !== field.key && (
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
            {field.key}
          </span>
        )}
      </Label>
      <Input
        id={id}
        type={
          field.type === "secret"
            ? "password"
            : field.type === "number"
              ? "number"
              : "text"
        }
        placeholder={field.description}
        value={
          Array.isArray(value)
            ? value.join(",")
            : value === undefined || value === null
              ? ""
              : String(value)
        }
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          if (field.type === "number") {
            const num = Number(raw);
            onChange(Number.isNaN(num) ? raw : num);
          } else {
            onChange(raw);
          }
        }}
      />
    </div>
  );
}

function usePromptedFields(
  form: UseFormReturn<McpCatalogFormValues>,
): PromptedField[] {
  const envVars = form.watch("localConfig.environment") ?? [];
  const headers = form.watch("additionalHeaders") ?? [];
  const result: PromptedField[] = [];

  for (const env of envVars) {
    if (!env?.promptOnInstallation || !env.key) continue;
    const t =
      env.type === "secret"
        ? "secret"
        : env.type === "boolean"
          ? "boolean"
          : env.type === "number"
            ? "number"
            : "string";
    result.push({
      key: env.key,
      label: env.key,
      type: t,
      description: env.description,
    });
  }

  const usedFieldNames = new Set<string>();
  for (const [index, header] of headers.entries()) {
    if (!header?.promptOnInstallation || !header.headerName) continue;
    const fieldName = getAdditionalHeaderFieldName({
      fieldName: header.fieldName,
      headerName: header.headerName,
      index,
      usedFieldNames,
    });
    usedFieldNames.add(fieldName);
    result.push({
      key: fieldName,
      label: header.headerName,
      type: "string",
      description: header.description || undefined,
    });
  }

  return result;
}
