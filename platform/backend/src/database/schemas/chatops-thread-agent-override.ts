import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import chatopsChannelBindingsTable from "./chatops-channel-binding";

/**
 * @deprecated The swap-agent feature was removed. This table is no longer
 * written or read by application code. It is intentionally retained (and kept
 * registered in the schema index) so Drizzle does NOT generate a destructive
 * drop migration. It may be dropped in a future, explicit migration.
 *
 * Historically: per-thread agent overrides for chatops channels. When
 * swap_agent was called during a ChatOps conversation, the override was stored
 * here instead of mutating the shared channel binding, so swaps were scoped to
 * the active thread/conversation.
 *
 * Unique constraint on (binding_id, thread_id) ensures one override per thread.
 */
const chatopsThreadAgentOverrideTable = pgTable(
  "chatops_thread_agent_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the channel binding this thread belongs to */
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => chatopsChannelBindingsTable.id, {
        onDelete: "cascade",
      }),
    /** Thread identifier (Slack thread_ts / Teams replyToId / channelId fallback for DMs) */
    threadId: varchar("thread_id", { length: 256 }).notNull(),
    /** The overridden agent for this specific thread */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One override per thread per binding
    uniqueIndex("chatops_thread_override_binding_thread_idx").on(
      table.bindingId,
      table.threadId,
    ),
    // Index for cleanup when an agent is deleted
    index("chatops_thread_override_agent_id_idx").on(table.agentId),
  ],
);

export default chatopsThreadAgentOverrideTable;
