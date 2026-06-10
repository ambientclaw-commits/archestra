import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { RouterMode } from "@/types";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import organizationsTable from "./organization";

const llmRoutersTable = pgTable(
  "llm_routers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Everyday/cheap candidate. FK to models(id) ON DELETE SET NULL. */
    cheapModelId: uuid("cheap_model_id").references(() => modelsTable.id, {
      onDelete: "set null",
    }),
    cheapApiKeyId: uuid("cheap_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /** Premium candidate. FK to models(id) ON DELETE SET NULL. */
    premiumModelId: uuid("premium_model_id").references(() => modelsTable.id, {
      onDelete: "set null",
    }),
    premiumApiKeyId: uuid("premium_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /** Admin-facing cost/quality knob; maps to a difficulty threshold. */
    mode: text("mode").$type<RouterMode>().notNull().default("balanced"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    organizationIdx: index("llm_routers_organization_id_idx").on(
      table.organizationId,
    ),
  }),
);

export default llmRoutersTable;
