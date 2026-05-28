"use client";

import { type CustomTheme, DEFAULT_THEME_ID, getThemeItemById } from "@shared";
import { useEffect, useRef, useState } from "react";
import { Editor } from "@/components/editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CustomThemeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: CustomTheme | null;
  /**
   * Fires only when the editor contains a syntactically valid theme — drives
   * the live preview on the page beneath the dialog.
   */
  onChange: (value: CustomTheme | null) => void;
  /**
   * Fires on every edit with whether the current text is valid. Lets the
   * parent gate the save bar so admins can't persist a half-typed JSON blob.
   */
  onValidityChange?: (isValid: boolean) => void;
  disabled?: boolean;
}

export function CustomThemeEditor({
  open,
  onOpenChange,
  value,
  onChange,
  onValidityChange,
  disabled,
}: CustomThemeEditorProps) {
  const [text, setText] = useState(() => formatJson(value));
  const [error, setError] = useState<string | null>(null);

  // The schema (set of keys in `light` and `dark`) is locked in the first
  // time the dialog opens with a non-null seed. After that, edits must keep
  // the exact same key set — no deletions, no renames, no typos — so an
  // admin can't accidentally remove `background` or rename `primary` to
  // `primay` and ship a broken theme.
  const schemaRef = useRef<ThemeSchema | null>(null);
  if (schemaRef.current === null && value) {
    schemaRef.current = extractSchema(value);
  }
  const schema = schemaRef.current;

  const wasOpenRef = useRef(false);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;
    // Only reseed the textarea on the open transition — not on every
    // `value` change while the user types, which would reformat their
    // in-progress edits.
    if (!wasOpen) {
      setText(formatJson(value));
      setError(null);
      onValidityChange?.(true);
    }
  }, [open, value, onValidityChange]);

  // Reset to the platform default theme — the same canonical baseline used
  // when a new org first selects "custom". Re-locks the schema to that
  // theme's keys so subsequent edits are validated against the default.
  const handleReset = () => {
    const defaultItem = getThemeItemById(DEFAULT_THEME_ID);
    if (!defaultItem) return;
    const reset: CustomTheme = {
      light: { ...defaultItem.cssVars.light },
      dark: { ...defaultItem.cssVars.dark },
    };
    schemaRef.current = extractSchema(reset);
    setText(formatJson(reset));
    setError(null);
    onChange(reset);
    onValidityChange?.(true);
  };

  const handleChange = (next: string) => {
    setText(next);
    const parsed = parseCustomTheme(next, schema);
    if (parsed.ok) {
      setError(null);
      onChange(parsed.value);
      onValidityChange?.(true);
    } else {
      setError(parsed.error);
      onValidityChange?.(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl h-[85dvh] overflow-hidden"
        onInteractOutside={(e) => {
          // Monaco's color picker is rendered into a <body>-level node (see
          // `overflowWidgetsDomNode` below), so it lives outside this dialog's
          // DOM subtree. Without this guard, clicking inside the picker counts
          // as an outside interaction and closes the dialog mid-edit.
          const target = e.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-monaco-overflow-widgets]")) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Custom Theme JSON</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <div className="border rounded-md overflow-hidden flex-1 min-h-0">
            <Editor
              height="100%"
              defaultLanguage="json"
              value={text}
              onChange={(v) => handleChange(v ?? "")}
              beforeMount={registerCssColorProvider}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: "on",
                readOnly: disabled,
                tabSize: 2,
                renderLineHighlight: "none",
                folding: false,
                colorDecorators: true,
                // Mount popups (color picker, hover, autocomplete) at document
                // root so they escape the dialog's overflow-hidden ancestors.
                fixedOverflowWidgets: true,
              }}
            />
          </div>
          {error && (
            <p className="text-xs text-destructive shrink-0" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={disabled}
          >
            Reset to default
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatJson(value: CustomTheme | null): string {
  if (!value) return "";
  return JSON.stringify(value, null, 2);
}

type ParseResult =
  | { ok: true; value: CustomTheme | null }
  | { ok: false; error: string };

type ThemeSchema = {
  lightKeys: ReadonlyArray<string>;
  darkKeys: ReadonlyArray<string>;
};

function extractSchema(theme: CustomTheme): ThemeSchema {
  return {
    lightKeys: Object.keys(theme.light).sort(),
    darkKeys: Object.keys(theme.dark).sort(),
  };
}

function parseCustomTheme(
  text: string,
  schema: ThemeSchema | null,
): ParseResult {
  const trimmed = text.trim();
  // A truly empty editor clears the custom theme. Only allow this when no
  // schema is locked in yet — otherwise we'd silently drop required keys.
  if (!trimmed) {
    if (schema) return { ok: false, error: "JSON cannot be empty" };
    return { ok: true, value: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const topLevelKeys = Object.keys(obj);
  const extraTop = topLevelKeys.filter((k) => k !== "light" && k !== "dark");
  if (extraTop.length) {
    return {
      ok: false,
      error: `Unknown top-level keys: ${extraTop.join(", ")}. Only \`light\` and \`dark\` are allowed.`,
    };
  }

  const light = obj.light;
  const dark = obj.dark;
  if (!isVarMap(light) || !isVarMap(dark)) {
    return {
      ok: false,
      error: "Expected `light` and `dark` to be objects of string values",
    };
  }

  for (const map of [light, dark] as const) {
    const scope = map === light ? "light" : "dark";
    for (const [key, val] of Object.entries(map)) {
      if (!val.trim()) {
        return { ok: false, error: `\`${scope}.${key}\` cannot be empty` };
      }
      if (key.startsWith("font-") && !isValidFontFamily(val)) {
        return {
          ok: false,
          error: `\`${scope}.${key}\` is not a valid CSS font-family value`,
        };
      }
    }
  }

  if (schema) {
    const lightDiff = diffKeys(Object.keys(light), schema.lightKeys);
    if (lightDiff) return { ok: false, error: `light ${lightDiff}` };
    const darkDiff = diffKeys(Object.keys(dark), schema.darkKeys);
    if (darkDiff) return { ok: false, error: `dark ${darkDiff}` };
  } else {
    // No schema yet — at minimum, light and dark must share the same keys
    // so the theme behaves consistently across color modes.
    const diff = diffKeys(Object.keys(light), Object.keys(dark).sort());
    if (diff) {
      return {
        ok: false,
        error: `\`light\` and \`dark\` must have the same keys (${diff})`,
      };
    }
  }

  return { ok: true, value: { light, dark } };
}

function diffKeys(
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): string | null {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((k) => !actualSet.has(k));
  const unknown = actual.filter((k) => !expectedSet.has(k));
  if (!missing.length && !unknown.length) return null;
  const parts: string[] = [];
  if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
  if (unknown.length) parts.push(`unknown: ${unknown.join(", ")}`);
  return parts.join("; ");
}

function isVarMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === "string",
  );
}

const fontValidationCache = new Map<string, boolean>();
let fontProbe: HTMLDivElement | null = null;

/**
 * Returns true when the browser accepts the value as a CSS `font-family`.
 * Uses CSS.supports() when available, falling back to a DOM-write probe —
 * the browser silently rejects invalid syntax (unquoted multi-word names,
 * leading-digit identifiers, dangling commas) by leaving the property empty.
 */
function isValidFontFamily(value: string): boolean {
  if (typeof document === "undefined") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const cached = fontValidationCache.get(trimmed);
  if (cached !== undefined) return cached;

  let valid: boolean;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    valid = CSS.supports("font-family", trimmed);
  } else {
    if (!fontProbe) fontProbe = document.createElement("div");
    fontProbe.style.fontFamily = "";
    fontProbe.style.fontFamily = trimmed;
    valid = fontProbe.style.fontFamily !== "";
  }
  fontValidationCache.set(trimmed, valid);
  return valid;
}

// ===
// Monaco color provider — renders inline color swatches next to any CSS color
// value found inside JSON string literals. Registered globally on first mount.

type Monaco = Parameters<
  NonNullable<import("@monaco-editor/react").EditorProps["beforeMount"]>
>[0];

let colorProviderRegistered = false;

function registerCssColorProvider(monaco: Monaco) {
  if (colorProviderRegistered) return;
  colorProviderRegistered = true;

  monaco.languages.registerColorProvider("json", {
    // biome-ignore lint/suspicious/noExplicitAny: Monaco namespace types aren't directly indexable
    provideDocumentColors(model: any) {
      const text = model.getValue();
      const colors: Array<{
        color: { red: number; green: number; blue: number; alpha: number };
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        };
      }> = [];

      // Walk every JSON string literal. Strings can't contain unescaped
      // double quotes, so this is sufficient for our shape.
      const stringPattern = /"((?:[^"\\]|\\.)*)"/g;
      for (const match of text.matchAll(stringPattern)) {
        const inner = match[1];
        if (match.index === undefined) continue;
        const color = parseCssColor(inner);
        if (!color) continue;

        const startOffset = match.index + 1; // skip opening quote
        const endOffset = startOffset + inner.length;
        const startPos = model.getPositionAt(startOffset);
        const endPos = model.getPositionAt(endOffset);
        colors.push({
          color,
          range: {
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
          },
        });
      }
      return colors;
    },
    // biome-ignore lint/suspicious/noExplicitAny: Monaco namespace types aren't directly indexable
    provideColorPresentations(model: any, info: any) {
      // Preserve the original format so picking a color from the swatch
      // doesn't collapse oklch to hex (and vice-versa).
      const original = (model.getValueInRange(info.range) as string).trim();
      const r = info.color.red;
      const g = info.color.green;
      const b = info.color.blue;
      const a = Math.max(0, Math.min(1, info.color.alpha));

      if (/^oklch\s*\(/i.test(original)) {
        const [L, C, H] = rgbToOklch(r, g, b);
        const label =
          a < 1
            ? `oklch(${trimNum(L, 3)} ${trimNum(C, 3)} ${trimNum(H, 1)} / ${trimNum(a, 2)})`
            : `oklch(${trimNum(L, 3)} ${trimNum(C, 3)} ${trimNum(H, 1)})`;
        return [{ label }];
      }
      if (/^hsla?\s*\(/i.test(original)) {
        const [h, s, l] = rgbToHsl(r, g, b);
        const label =
          a < 1
            ? `hsl(${trimNum(h, 1)} ${trimNum(s * 100, 1)}% ${trimNum(l * 100, 1)}% / ${trimNum(a, 2)})`
            : `hsl(${trimNum(h, 1)} ${trimNum(s * 100, 1)}% ${trimNum(l * 100, 1)}%)`;
        return [{ label }];
      }
      if (/^rgba?\s*\(/i.test(original)) {
        const label =
          a < 1
            ? `rgb(${clamp255(r)} ${clamp255(g)} ${clamp255(b)} / ${trimNum(a, 2)})`
            : `rgb(${clamp255(r)} ${clamp255(g)} ${clamp255(b)})`;
        return [{ label }];
      }
      // Hex fallback
      const hex = `#${toHex2(clamp255(r))}${toHex2(clamp255(g))}${toHex2(clamp255(b))}${
        a < 1 ? toHex2(Math.round(a * 255)) : ""
      }`;
      return [{ label: hex }];
    },
  });
}

const cssColorCache = new Map<
  string,
  { red: number; green: number; blue: number; alpha: number } | null
>();

let parseCanvas: HTMLCanvasElement | null = null;

/**
 * Convert any CSS color string (including modern oklch/lab/color()) to sRGB
 * by drawing it onto a 1×1 canvas and reading back the pixel. This is more
 * reliable than `getComputedStyle().color` since some browsers leave wide-gamut
 * values un-normalised, leaving the regex parse with no rgb() to match.
 */
function parseCssColor(input: string) {
  if (typeof document === "undefined") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (!LOOKS_LIKE_COLOR.test(trimmed)) return null;

  if (cssColorCache.has(trimmed)) return cssColorCache.get(trimmed) ?? null;

  if (!parseCanvas) {
    parseCanvas = document.createElement("canvas");
    parseCanvas.width = 1;
    parseCanvas.height = 1;
  }
  const ctx = parseCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    cssColorCache.set(trimmed, null);
    return null;
  }

  // Reset to a known sentinel so we can detect rejection. Canvas keeps the
  // last successful fillStyle when given an unparseable value.
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = trimmed;
  if (ctx.fillStyle === "rgba(0, 0, 0, 0)") {
    cssColorCache.set(trimmed, null);
    return null;
  }
  ctx.fillRect(0, 0, 1, 1);

  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const parsed = {
    red: r / 255,
    green: g / 255,
    blue: b / 255,
    alpha: a / 255,
  };
  cssColorCache.set(trimmed, parsed);
  return parsed;
}

const LOOKS_LIKE_COLOR =
  /^(#[0-9a-f]{3,8}|(oklch|oklab|lch|lab|hsl|hsla|rgb|rgba|color|hwb)\s*\()/i;

function clamp255(v: number) {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function toHex2(n: number) {
  return n.toString(16).padStart(2, "0");
}

function trimNum(n: number, decimals: number): string {
  return Number.parseFloat(n.toFixed(decimals)).toString();
}

/**
 * sRGB (0..1) → OKLCH. Reference: https://bottosson.github.io/posts/oklab/
 * Returns L (0..1), C (chroma), H (hue degrees 0..360).
 */
function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const lr = lin(r);
  const lg = lin(g);
  const lb = lin(b);

  const l_ = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m_ = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s_ = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}
