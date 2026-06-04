import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  InternalMcpCatalogServerType,
  LocalMcpServerInstallationStatus,
  ResourceVisibilityScope,
} from "@/types";
import mcpCatalogTable from "./internal-mcp-catalog";
import secretTable from "./secret";
import { team } from "./team";
import usersTable from "./user";

// OAuth refresh error codes:
// - refresh_failed: refresh was attempted but failed
// - no_refresh_token: can't attempt recovery, no refresh token available
export const oauthRefreshErrorEnum = pgEnum("oauth_refresh_error_enum", [
  "refresh_failed",
  "no_refresh_token",
]);

const mcpServerTable = pgTable(
  "mcp_server",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    catalogId: uuid("catalog_id")
      .references(() => mcpCatalogTable.id, {
        onDelete: "set null",
      })
      .notNull(),
    serverType: text("server_type")
      .$type<InternalMcpCatalogServerType>()
      .notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    /**
     * Per-install plain (non-secret) env values for `promptOnInstallation`
     * env vars — supplied by the user in the install dialog and re-applied
     * by the runtime manager on every (re)deploy.
     *
     * Secret-typed prompted env values are not stored here; they live in
     * the per-install K8s Secret bundle referenced by `secretId`.
     *
     * Shape: `{ [envVarKey]: stringValue }`.
     */
    environmentValues: jsonb("environment_values")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    ownerId: text("owner_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    teamId: text("team_id").references(() => team.id, {
      onDelete: "set null",
    }),
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
    reinstallRequired: boolean("reinstall_required").notNull().default(false),
    /**
     * The K8s namespace this install's Deployment currently runs in, recorded
     * at deploy time. Teardown/relocation reads this to delete the pod where it
     * ACTUALLY is — instead of re-deriving the namespace from the catalog's
     * (possibly already-updated) environment, which orphans the pod when the
     * runtime's in-memory deployment cache is cold or stale (multi-replica).
     * Null for never-deployed or legacy rows; callers fall back to resolving
     * from the catalog's environment.
     */
    k8sNamespace: text("k8s_namespace"),
    localInstallationStatus: text("local_installation_status")
      .notNull()
      .default("idle")
      .$type<LocalMcpServerInstallationStatus>(),
    localInstallationError: text("local_installation_error"),
    oauthRefreshError: oauthRefreshErrorEnum("oauth_refresh_error"),
    oauthRefreshFailedAt: timestamp("oauth_refresh_failed_at", {
      mode: "date",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("mcp_server_scope_idx").on(table.scope)],
);

export default mcpServerTable;
