import type { Caller, McpServer, McpToolAssignment } from "@/types";

// Pure connection-resolution policy: which installed MCP server (and so whose
// credential) a tool call uses. Extracted from mcp-client so the policy is
// readable and testable in one place, with no transport or DB concerns. The
// four modes, in order:
// - assignment pin   — the agent_tools row names a server (static mode)
// - enterprise       — enterprise-managed credentials; any install of the
//                      catalog works, the pod brokers credentials via the IdP
// - service account  — the catalog pins one connection every runtime-resolved
//                      call uses ("Always use one account"); re-validated per
//                      call so a revoked pin degrades to on-behalf-of
// - on behalf of     — strictly the caller's own connection (user token →
//                      that user's install, team token → that team's); no
//                      team/org borrowing — sharing is the explicit pin above

/** The subset of an installed server the resolver needs. */
type ConnectionCandidate = Pick<
  McpServer,
  "id" | "name" | "ownerId" | "teamId" | "scope"
>;

type ConnectionDenialCode =
  /** Static assignment without a bound server id. */
  | "static_assignment_missing_server"
  /** Enterprise-managed mode but the catalog has no installation at all. */
  | "enterprise_no_installation"
  /** Runtime resolution needs a catalog id on the tool row. */
  | "missing_catalog_id"
  /** Org-wide tokens carry no resolvable identity for on-behalf-of calls. */
  | "org_token_unsupported"
  /** No usable connection for this caller — prompt them to connect. */
  | "auth_required";

type ConnectionResolution =
  | {
      status: "resolved";
      serverId: string;
      /**
       * Null when the policy names a server id directly (assignment pin or
       * an explicit enterprise install) — the caller looks the name up.
       */
      serverName: string | null;
      via:
        | "assignment"
        | "enterprise"
        | "serviceAccount"
        | "ownConnection"
        | "teamConnection"
        | "externalIdpFallback";
      /** The catalog pinned a connection that no longer exists. */
      serviceAccountPinDegraded?: boolean;
    }
  | {
      status: "denied";
      reason: ConnectionDenialCode;
      serviceAccountPinDegraded?: boolean;
    };

export function resolveConnection(params: {
  credentialResolutionMode: McpToolAssignment["credentialResolutionMode"];
  /** Server bound on the assignment row (static / explicit enterprise). */
  assignedMcpServerId: string | null;
  catalogId: string | null;
  /** The catalog's pinned service-account connection, if configured. */
  dynamicConnectionMcpServerId: string | null;
  caller: Caller;
  /** All installations of the tool's catalog. */
  servers: ConnectionCandidate[];
}): ConnectionResolution {
  const { caller, servers } = params;

  if (params.credentialResolutionMode === "static") {
    return params.assignedMcpServerId
      ? {
          status: "resolved",
          serverId: params.assignedMcpServerId,
          serverName: null,
          via: "assignment",
        }
      : { status: "denied", reason: "static_assignment_missing_server" };
  }

  if (params.credentialResolutionMode === "enterprise_managed") {
    if (params.assignedMcpServerId) {
      return {
        status: "resolved",
        serverId: params.assignedMcpServerId,
        serverName: null,
        via: "enterprise",
      };
    }
    const anyInstall = servers[0];
    return anyInstall
      ? {
          status: "resolved",
          serverId: anyInstall.id,
          serverName: anyInstall.name,
          via: "enterprise",
        }
      : { status: "denied", reason: "enterprise_no_installation" };
  }

  // Runtime ("dynamic") resolution from here on.
  if (!params.catalogId) {
    return { status: "denied", reason: "missing_catalog_id" };
  }

  let serviceAccountPinDegraded = false;
  if (params.dynamicConnectionMcpServerId) {
    const pinned = servers.find(
      (server) => server.id === params.dynamicConnectionMcpServerId,
    );
    if (pinned) {
      return {
        status: "resolved",
        serverId: pinned.id,
        serverName: pinned.name,
        via: "serviceAccount",
      };
    }
    serviceAccountPinDegraded = true;
  }

  switch (caller.kind) {
    case "user": {
      const own = servers.find(
        (server) =>
          server.ownerId === caller.userId &&
          !server.teamId &&
          server.scope !== "org",
      );
      if (own) {
        return {
          status: "resolved",
          serverId: own.id,
          serverName: own.name,
          via: "ownConnection",
          serviceAccountPinDegraded,
        };
      }
      if (caller.teamId) {
        const team = servers.find((server) => server.teamId === caller.teamId);
        if (team) {
          return {
            status: "resolved",
            serverId: team.id,
            serverName: team.name,
            via: "teamConnection",
            serviceAccountPinDegraded,
          };
        }
      }
      if (caller.viaExternalIdp && servers[0]) {
        return {
          status: "resolved",
          serverId: servers[0].id,
          serverName: servers[0].name,
          via: "externalIdpFallback",
          serviceAccountPinDegraded,
        };
      }
      return {
        status: "denied",
        reason: "auth_required",
        serviceAccountPinDegraded,
      };
    }
    case "team": {
      const team = servers.find((server) => server.teamId === caller.teamId);
      return team
        ? {
            status: "resolved",
            serverId: team.id,
            serverName: team.name,
            via: "teamConnection",
            serviceAccountPinDegraded,
          }
        : {
            status: "denied",
            reason: "auth_required",
            serviceAccountPinDegraded,
          };
    }
    case "organization":
      return {
        status: "denied",
        reason: "org_token_unsupported",
        serviceAccountPinDegraded,
      };
    case "externalIdp":
      // TODO: only sound for the end-to-end JWKS pattern (pre-existing).
      return servers[0]
        ? {
            status: "resolved",
            serverId: servers[0].id,
            serverName: servers[0].name,
            via: "externalIdpFallback",
            serviceAccountPinDegraded,
          }
        : {
            status: "denied",
            reason: "auth_required",
            serviceAccountPinDegraded,
          };
    case "anonymous":
      return {
        status: "denied",
        reason: "auth_required",
        serviceAccountPinDegraded,
      };
  }
}
