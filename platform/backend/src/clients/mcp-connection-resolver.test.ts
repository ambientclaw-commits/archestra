import { describe, expect, test } from "vitest";
import { callerFromTokenAuth } from "@/types";
import { resolveConnection } from "./mcp-connection-resolver";

type ConnectionCandidate = Parameters<
  typeof resolveConnection
>[0]["servers"][number];

// Pure-policy tests — no DB, no mocks. The mcp-client integration tests cover
// the same behavior end to end; these pin the decision table itself.

function candidate(
  overrides: Partial<ConnectionCandidate> & { id: string },
): ConnectionCandidate {
  return {
    name: `server-${overrides.id}`,
    ownerId: null,
    teamId: null,
    scope: "personal",
    ...overrides,
  };
}

const user = callerFromTokenAuth({
  userId: "user-1",
  teamId: null,
  isOrganizationToken: false,
});

function resolve(
  overrides: Partial<Parameters<typeof resolveConnection>[0]> = {},
) {
  return resolveConnection({
    credentialResolutionMode: "dynamic",
    assignedMcpServerId: null,
    catalogId: "catalog-1",
    dynamicConnectionMcpServerId: null,
    caller: user,
    servers: [],
    ...overrides,
  });
}

describe("callerFromTokenAuth", () => {
  test("normalizes each token shape to one exclusive kind", () => {
    expect(callerFromTokenAuth(undefined)).toEqual({ kind: "anonymous" });
    expect(
      callerFromTokenAuth({
        userId: "u1",
        teamId: null,
        isOrganizationToken: false,
      }),
    ).toEqual({
      kind: "user",
      userId: "u1",
      teamId: null,
      viaExternalIdp: false,
    });
    expect(
      callerFromTokenAuth({ teamId: "t1", isOrganizationToken: false }),
    ).toEqual({ kind: "team", teamId: "t1" });
    expect(
      callerFromTokenAuth({ teamId: null, isOrganizationToken: true }),
    ).toEqual({ kind: "organization" });
    expect(
      callerFromTokenAuth({
        teamId: null,
        isOrganizationToken: false,
        isExternalIdp: true,
      }),
    ).toEqual({ kind: "externalIdp" });
  });

  test("a user identity wins over the token's other claims", () => {
    expect(
      callerFromTokenAuth({
        userId: "u1",
        teamId: "t1",
        isOrganizationToken: false,
        isExternalIdp: true,
      }),
    ).toEqual({
      kind: "user",
      userId: "u1",
      teamId: "t1",
      viaExternalIdp: true,
    });
  });
});

describe("resolveConnection — assignment pin (static)", () => {
  test("uses the assignment's server without consulting candidates", () => {
    expect(
      resolve({
        credentialResolutionMode: "static",
        assignedMcpServerId: "srv-1",
      }),
    ).toEqual({
      status: "resolved",
      serverId: "srv-1",
      serverName: null,
      via: "assignment",
    });
  });

  test("denies when the assignment lost its server", () => {
    expect(resolve({ credentialResolutionMode: "static" })).toEqual({
      status: "denied",
      reason: "static_assignment_missing_server",
    });
  });
});

describe("resolveConnection — enterprise managed", () => {
  test("prefers the explicitly assigned install", () => {
    expect(
      resolve({
        credentialResolutionMode: "enterprise_managed",
        assignedMcpServerId: "srv-explicit",
        servers: [candidate({ id: "srv-other" })],
      }),
    ).toMatchObject({ status: "resolved", serverId: "srv-explicit" });
  });

  test("falls back to any install of the catalog", () => {
    expect(
      resolve({
        credentialResolutionMode: "enterprise_managed",
        servers: [candidate({ id: "srv-any" })],
      }),
    ).toMatchObject({
      status: "resolved",
      serverId: "srv-any",
      via: "enterprise",
    });
  });

  test("denies when the catalog has no install", () => {
    expect(resolve({ credentialResolutionMode: "enterprise_managed" })).toEqual(
      { status: "denied", reason: "enterprise_no_installation" },
    );
  });
});

describe("resolveConnection — service account pin", () => {
  test("the pinned connection wins for every caller, even with an own connection present", () => {
    const servers = [
      candidate({ id: "own", ownerId: "user-1" }),
      candidate({ id: "shared", scope: "org" }),
    ];
    expect(
      resolve({ dynamicConnectionMcpServerId: "shared", servers }),
    ).toMatchObject({
      status: "resolved",
      serverId: "shared",
      via: "serviceAccount",
    });
  });

  test("a revoked pin degrades to on-behalf-of and flags the degradation", () => {
    const servers = [candidate({ id: "own", ownerId: "user-1" })];
    expect(
      resolve({ dynamicConnectionMcpServerId: "gone", servers }),
    ).toMatchObject({
      status: "resolved",
      serverId: "own",
      via: "ownConnection",
      serviceAccountPinDegraded: true,
    });
  });
});

describe("resolveConnection — on behalf of the caller", () => {
  test("a user resolves only to their own connection", () => {
    const servers = [
      candidate({ id: "team", teamId: "t1" }),
      candidate({ id: "org", scope: "org" }),
      candidate({ id: "own", ownerId: "user-1" }),
    ];
    expect(resolve({ servers })).toMatchObject({
      status: "resolved",
      serverId: "own",
      via: "ownConnection",
    });
  });

  test("a user never borrows team or org connections", () => {
    const servers = [
      candidate({ id: "team", teamId: "t-other" }),
      candidate({ id: "org", scope: "org" }),
    ];
    expect(resolve({ servers })).toMatchObject({
      status: "denied",
      reason: "auth_required",
    });
  });

  test("a user token carrying team context may use that team's connection", () => {
    const teamUser = callerFromTokenAuth({
      userId: "user-1",
      teamId: "t1",
      isOrganizationToken: false,
    });
    const servers = [candidate({ id: "team", teamId: "t1" })];
    expect(resolve({ caller: teamUser, servers })).toMatchObject({
      status: "resolved",
      serverId: "team",
      via: "teamConnection",
    });
  });

  test("a team token resolves to its own team's connection only", () => {
    const teamCaller = callerFromTokenAuth({
      teamId: "t1",
      isOrganizationToken: false,
    });
    expect(
      resolve({
        caller: teamCaller,
        servers: [candidate({ id: "team", teamId: "t1" })],
      }),
    ).toMatchObject({ status: "resolved", serverId: "team" });
    expect(
      resolve({
        caller: teamCaller,
        servers: [candidate({ id: "org", scope: "org" })],
      }),
    ).toMatchObject({ status: "denied", reason: "auth_required" });
  });

  test("organization tokens are rejected outright", () => {
    const orgCaller = callerFromTokenAuth({
      teamId: null,
      isOrganizationToken: true,
    });
    expect(
      resolve({
        caller: orgCaller,
        servers: [candidate({ id: "org", scope: "org" })],
      }),
    ).toMatchObject({ status: "denied", reason: "org_token_unsupported" });
  });

  test("external IdP callers fall back to the first available install", () => {
    const idpUser = callerFromTokenAuth({
      userId: "user-1",
      teamId: null,
      isOrganizationToken: false,
      isExternalIdp: true,
    });
    const servers = [candidate({ id: "first" })];
    expect(resolve({ caller: idpUser, servers })).toMatchObject({
      status: "resolved",
      serverId: "first",
      via: "externalIdpFallback",
    });

    const unmappedIdp = callerFromTokenAuth({
      teamId: null,
      isOrganizationToken: false,
      isExternalIdp: true,
    });
    expect(resolve({ caller: unmappedIdp, servers })).toMatchObject({
      status: "resolved",
      serverId: "first",
      via: "externalIdpFallback",
    });
  });

  test("runtime resolution without a catalog id is denied", () => {
    expect(resolve({ catalogId: null })).toEqual({
      status: "denied",
      reason: "missing_catalog_id",
    });
  });
});
