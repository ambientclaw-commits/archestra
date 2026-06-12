// How a request is authenticated, as a tagged union. The wire shape
// (TokenAuthContext) is a bag of optional fields whose combinations are
// produced by distinct validators — user/OAuth tokens carry a userId, team
// tokens a teamId, organization tokens only a flag, external IdP JWTs a flag
// plus an optionally mapped user. Normalizing them into one exclusive kind
// per request lets policy code switch exhaustively instead of re-deriving the
// kind from field presence at every call site.

export type Caller =
  | {
      kind: "user";
      userId: string;
      /** Team context carried by the token, if any. */
      teamId: string | null;
      /**
       * Authenticated via an external IdP JWT (enables the JWKS last-resort
       * connection fallback during dynamic credential resolution).
       */
      viaExternalIdp: boolean;
    }
  | { kind: "team"; teamId: string }
  | { kind: "organization" }
  /** External IdP JWT that did not map to an Archestra user. */
  | { kind: "externalIdp" }
  | { kind: "anonymous" };

/**
 * Normalize a token-auth context into a Caller. Structural parameter type so
 * it accepts TokenAuthContext (clients/mcp-client.ts) without a type cycle.
 * Precedence mirrors the order resolution code historically checked the
 * fields: user identity wins, then team, then organization, then external
 * IdP; anything else (absent or empty) is anonymous.
 */
export function callerFromTokenAuth(tokenAuth?: {
  userId?: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  isExternalIdp?: boolean;
}): Caller {
  if (!tokenAuth) {
    return { kind: "anonymous" };
  }
  if (tokenAuth.userId) {
    return {
      kind: "user",
      userId: tokenAuth.userId,
      teamId: tokenAuth.teamId ?? null,
      viaExternalIdp: tokenAuth.isExternalIdp ?? false,
    };
  }
  if (tokenAuth.teamId) {
    return { kind: "team", teamId: tokenAuth.teamId };
  }
  if (tokenAuth.isOrganizationToken) {
    return { kind: "organization" };
  }
  if (tokenAuth.isExternalIdp) {
    return { kind: "externalIdp" };
  }
  return { kind: "anonymous" };
}
