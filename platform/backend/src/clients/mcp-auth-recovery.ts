import {
  type AssignedCredentialUnavailableMcpToolError,
  type AuthExpiredMcpToolError,
  type AuthRequiredMcpToolError,
  LINKED_IDP_SSO_MODE,
  MCP_CATALOG_INSTALL_PATH,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
} from "@archestra/shared";
import config from "@/config";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";

// Actionable recovery messages for credential failures: each names the
// problem, links the exact page that fixes it, and says what to do after.
// Grouped here (out of mcp-client) because they are the user-facing half of
// connection resolution — mcp-connection-resolver decides, these explain.

/** Minimal token-auth shape needed to describe whose credentials failed. */
type AuthContext = {
  userId?: string;
  teamId: string | null;
};

/** No usable connection for this caller — link the install/connect flow. */
export function buildAuthRequiredMessage(
  catalogDisplayName: string,
  catalogId: string,
  tokenAuth?: AuthContext,
): AuthRequiredMcpToolError {
  const context = formatAuthContext(tokenAuth);
  const installUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_INSTALL_QUERY_PARAM}=${catalogId}`;
  return {
    type: "auth_required",
    message: formatActionableAuthError({
      title: `Authentication required for "${catalogDisplayName}"`,
      detail: `No credentials were found for your account (${context}).`,
      actionLabel: "set up your credentials",
      url: installUrl,
      postAction:
        "Once you have completed authentication, retry this tool call.",
    }),
    catalogId,
    catalogName: catalogDisplayName,
    action: "install_mcp_credentials",
    actionUrl: installUrl,
  };
}

/**
 * Expired or invalid credentials, with a deep link to the re-authentication
 * dialog for the failing connection.
 */
export function buildExpiredAuthMessage(
  catalogDisplayName: string,
  catalogId: string,
  mcpServerId: string,
  tokenAuth?: AuthContext,
  detailOverride?: string,
): AuthExpiredMcpToolError {
  const context = formatAuthContext(tokenAuth);
  const reauthUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${catalogId}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServerId}`;
  return {
    type: "auth_expired",
    message: formatActionableAuthError({
      title: `Expired or invalid authentication for "${catalogDisplayName}"`,
      detail:
        detailOverride ??
        `Your credentials (${context}) failed authentication. Please re-authenticate to continue using this tool.`,
      actionLabel: "re-authenticate",
      url: reauthUrl,
      postAction: "Once you have re-authenticated, retry this tool call.",
    }),
    catalogId,
    catalogName: catalogDisplayName,
    serverId: mcpServerId,
    reauthUrl,
  };
}

/**
 * A statically assigned credential failed and the caller cannot fix it
 * themselves — steer them to the connection owner or an admin.
 */
export function buildAssignedCredentialUnavailableMessage(
  catalogDisplayName: string,
  catalogId: string,
): AssignedCredentialUnavailableMcpToolError {
  return {
    type: "assigned_credential_unavailable",
    message: [
      `Expired / Invalid Authentication: credentials for "${catalogDisplayName}" have expired or are invalid.`,
      "Re-authenticate to continue using this tool.",
      "Ask the agent owner or an admin to re-authenticate.",
    ].join("\n"),
    catalogId,
    catalogName: catalogDisplayName,
  };
}

/**
 * Enterprise-managed credentials need a live downstream IdP session — link
 * the SSO connect flow for the provider, falling back to the plain
 * auth-required message when the provider is unknown.
 */
export async function buildEnterpriseManagedIdentityProviderAuthMessage(
  catalogDisplayName: string,
  catalogId: string,
  identityProviderId: string | null,
  tokenAuth?: AuthContext,
  options?: {
    conversationId?: string;
    identityProviderRedirectPath?: string;
  },
): Promise<AuthRequiredMcpToolError> {
  const identityProvider = identityProviderId
    ? await findExternalIdentityProviderById(identityProviderId)
    : null;
  if (!identityProvider) {
    return buildAuthRequiredMessage(catalogDisplayName, catalogId, tokenAuth);
  }

  const connectUrl = buildIdentityProviderConnectUrl(
    identityProvider.providerId,
    options,
  );
  return {
    type: "auth_required",
    message: formatActionableAuthError({
      title: `Authentication required for "${catalogDisplayName}"`,
      detail: `This tool needs a current ${identityProvider.providerId} session for your account before this deployment can request the downstream credential.`,
      actionLabel: `connect ${identityProvider.providerId}`,
      url: connectUrl,
      postAction:
        "Once you have completed authentication, retry this tool call.",
    }),
    catalogId,
    catalogName: catalogDisplayName,
    action: "connect_identity_provider",
    actionUrl: connectUrl,
    providerId: identityProvider.providerId,
  };
}

// === Internal helpers ===

/**
 * Format an actionable auth error message that strongly encourages the LLM
 * to display the URL to the user. The wording is intentionally directive
 * so that models reliably surface the link rather than paraphrasing it away.
 */
function formatActionableAuthError(params: {
  title: string;
  detail: string;
  actionLabel: string;
  url: string;
  postAction: string;
}): string {
  return [
    `${params.title}.`,
    "",
    params.detail,
    `To ${params.actionLabel}, visit this URL: ${params.url}`,
    "",
    "IMPORTANT: You MUST display the URL above to the user exactly as shown. Do NOT omit it or paraphrase it.",
    "",
    params.postAction,
  ].join("\n");
}

function buildIdentityProviderConnectUrl(
  providerId: string,
  options?: {
    conversationId?: string;
    identityProviderRedirectPath?: string;
  },
): string {
  const redirectTo = getIdentityProviderRedirectPath(options);
  const searchParams = new URLSearchParams({
    redirectTo,
    mode: LINKED_IDP_SSO_MODE,
  });
  return `${config.frontendBaseUrl}/auth/sso/${encodeURIComponent(providerId)}?${searchParams.toString()}`;
}

function getIdentityProviderRedirectPath(options?: {
  conversationId?: string;
  identityProviderRedirectPath?: string;
}): string {
  if (
    options?.identityProviderRedirectPath?.startsWith("/") &&
    !options.identityProviderRedirectPath.startsWith("//")
  ) {
    return options.identityProviderRedirectPath;
  }

  if (options?.conversationId) {
    return `/chat/${options.conversationId}`;
  }

  return "/chat";
}

function formatAuthContext(tokenAuth?: AuthContext): string {
  if (tokenAuth?.userId) return `user: ${tokenAuth.userId}`;
  if (tokenAuth?.teamId) return `team: ${tokenAuth.teamId}`;
  return "organization";
}
