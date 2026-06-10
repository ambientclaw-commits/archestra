import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Admin-facing cost/quality knob. Each mode maps to a calibrated difficulty
 * threshold in the routing seam (see services/smart-router).
 */
export const RouterModeSchema = z.enum(["cost", "balanced", "quality"]);
export type RouterMode = z.infer<typeof RouterModeSchema>;

const extendedFields = {
  mode: RouterModeSchema,
};

export const SelectLlmRouterSchema = createSelectSchema(
  schema.llmRoutersTable,
  extendedFields,
);

export const InsertLlmRouterSchema = createInsertSchema(
  schema.llmRoutersTable,
  extendedFields,
).omit({ id: true, createdAt: true, updatedAt: true });

export const UpdateLlmRouterSchema = createUpdateSchema(
  schema.llmRoutersTable,
  extendedFields,
).pick({
  name: true,
  enabled: true,
  cheapModelId: true,
  cheapApiKeyId: true,
  premiumModelId: true,
  premiumApiKeyId: true,
  mode: true,
});

export type LlmRouter = z.infer<typeof SelectLlmRouterSchema>;
export type InsertLlmRouter = z.infer<typeof InsertLlmRouterSchema>;
export type UpdateLlmRouter = z.infer<typeof UpdateLlmRouterSchema>;
