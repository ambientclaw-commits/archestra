"use client";

import type { SupportedProvider } from "@archestra/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { ClientPicker } from "./client-grid";
import { CONNECT_CLIENTS } from "./clients";
import {
  type ConnectionBaseUrl,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
  resolveEffectiveId,
  resolveInitialClientId,
} from "./connection-flow.utils";
import { ConnectionUrlStep } from "./connection-url-step";
import { McpClientInstructions } from "./mcp-client-instructions";
import { ProxyClientInstructions } from "./proxy-client-instructions";
import { SearchableSelect } from "./searchable-select";
import { SectionHeading } from "./section-heading";
import { SkillsMarketplaceStep } from "./skills-marketplace-step";
import { StepCard, type StepState } from "./step-card";
import { useUpdateUrlParams } from "./use-update-url-params";

interface ConnectionFlowProps {
  defaultMcpGatewayId?: string;
  defaultLlmProxyId?: string;
  adminDefaultMcpGatewayId?: string | null;
  adminDefaultLlmProxyId?: string | null;
  adminDefaultClientId?: string | null;
  /** When null/undefined: show all. Otherwise: only these IDs (plus "generic" always). */
  shownClientIds?: readonly string[] | null;
  /** When null/undefined: show all. Otherwise: only these providers. */
  shownProviders?: readonly SupportedProvider[] | null;
  /** Admin-curated descriptions and default flag for env-configured base URLs. */
  connectionBaseUrls?: readonly ConnectionBaseUrl[] | null;
}

export function ConnectionFlow({
  defaultMcpGatewayId,
  defaultLlmProxyId,
  adminDefaultMcpGatewayId,
  adminDefaultLlmProxyId,
  adminDefaultClientId: _adminDefaultClientId,
  shownClientIds,
  shownProviders,
  connectionBaseUrls,
}: ConnectionFlowProps) {
  const searchParams = useSearchParams();
  const urlGatewayId = searchParams.get("gatewayId");
  const urlProxyId = searchParams.get("proxyId");
  const urlClientId = searchParams.get("clientId");
  const from = searchParams.get("from");
  const fromTable = from === "table";

  const updateUrlParams = useUpdateUrlParams();

  const { data: mcpGateways } = useProfiles({
    filters: {
      agentTypes: ["profile", "mcp_gateway"],
      excludeOtherPersonalAgents: true,
    },
  });
  const { data: llmProxies } = useProfiles({
    filters: {
      agentTypes: ["profile", "llm_proxy"],
      excludeOtherPersonalAgents: true,
    },
  });

  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });

  const visibleClients = useMemo(() => {
    if (!shownClientIds) return CONNECT_CLIENTS;
    const shown = new Set(shownClientIds);
    // "generic" ("Any client") is always visible regardless of admin config.
    return CONNECT_CLIENTS.filter((c) => c.id === "generic" || shown.has(c.id));
  }, [shownClientIds]);

  // Only honor the URL param on first load. The picker intentionally starts
  // empty so users explicitly choose their client; the admin default still
  // affects the URL-based deep-link path via resolveInitialClientId callers
  // elsewhere, but it does not auto-pick a tile here.
  const initialClientId = resolveInitialClientId({
    urlClientId,
    adminDefaultClientId: null,
    visibleClientIds: visibleClients.map((c) => c.id),
  });
  const [clientId, setClientId] = useState<string | null>(initialClientId);
  const client = visibleClients.find((c) => c.id === clientId) ?? null;

  const selectClient = (id: string | null) => {
    setClientId(id);
    // Providers vary per client, so clear any bookmarked provider on switch.
    updateUrlParams({ clientId: id, providerId: null });
  };

  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const [selectedProxyId, setSelectedProxyId] = useState<string | null>(null);

  // Connection base URL — chosen once for the whole page, threaded into each
  // instruction panel below. Admins can hide individual env URLs from end
  // users; we filter those out here. Falls back to the admin default, then the
  // first remaining env URL, then the in-cluster internal URL.
  const candidateBaseUrls = useMemo(
    () =>
      resolveCandidateBaseUrls({
        externalProxyUrls: config.api.externalProxyUrls,
        internalProxyUrl: config.api.internalProxyUrl,
        metadata: connectionBaseUrls,
      }),
    [connectionBaseUrls],
  );
  const adminDefaultBaseUrl = useMemo(
    () => resolveAdminDefaultBaseUrl(connectionBaseUrls),
    [connectionBaseUrls],
  );
  // Derived, not stateful: this lets the admin default take effect after the
  // org data resolves on initial load. Once the user manually picks a URL,
  // `userBaseUrl` overrides every fallback below.
  const [userBaseUrl, setUserBaseUrl] = useState<string | null>(null);
  const baseUrl =
    (userBaseUrl && candidateBaseUrls.includes(userBaseUrl) && userBaseUrl) ||
    (adminDefaultBaseUrl &&
      candidateBaseUrls.includes(adminDefaultBaseUrl) &&
      adminDefaultBaseUrl) ||
    candidateBaseUrls[0];

  const handleMcpSelect = (id: string) => {
    setSelectedMcpId(id);
    updateUrlParams({ gatewayId: id });
  };
  const handleProxySelect = (id: string) => {
    setSelectedProxyId(id);
    updateUrlParams({ proxyId: id });
  };

  // When arriving from the opposite slot's table (only that slot's ID is
  // pinned in the URL), skip this slot's admin default so it doesn't override
  // the user's intent — fall through to the system default instead.
  const effectiveMcpId = resolveEffectiveId({
    selected: selectedMcpId,
    fromUrl: urlGatewayId,
    adminDefault: adminDefaultMcpGatewayId,
    systemDefault: defaultMcpGatewayId,
    firstAvailable: mcpGateways?.[0]?.id,
    skipAdminDefault: fromTable && !!urlProxyId && !urlGatewayId,
  });

  const effectiveProxyId = resolveEffectiveId({
    selected: selectedProxyId,
    fromUrl: urlProxyId,
    adminDefault: adminDefaultLlmProxyId,
    systemDefault: defaultLlmProxyId,
    firstAvailable: llmProxies?.[0]?.id,
    skipAdminDefault: fromTable && !!urlGatewayId && !urlProxyId,
  });

  const selectedMcp = mcpGateways?.find((g) => g.id === effectiveMcpId);
  const stepState: StepState = clientId ? "active" : "todo";

  return (
    <div className="grid gap-3.5">
      {/* Step 1 — Client */}
      <ClientPicker
        clients={visibleClients}
        selected={clientId}
        onSelect={selectClient}
      />

      {/* Connection URL — picked once, reused by every snippet below. */}
      <ConnectionUrlStep
        candidateUrls={candidateBaseUrls}
        metadata={connectionBaseUrls}
        value={baseUrl}
        onChange={setUserBaseUrl}
        disabled={!clientId}
      />

      {/* Step 2 — MCP Gateway */}
      {client && canReadMcpGateway && (
        <div
          key={`mcp-${client.id}`}
          className="grid gap-3.5 animate-in fade-in slide-in-from-bottom-2 duration-500 [animation-delay:0ms] [animation-fill-mode:backwards]"
        >
          <SectionHeading step={1} title="Connect the MCP Gateway" />
          <StepCard
            hideStatus
            pinned
            state={stepState}
            expanded
            actions={
              client &&
              client.mcp.kind !== "unsupported" &&
              (mcpGateways?.length ?? 0) > 1 ? (
                <SearchableSelect
                  options={(mcpGateways ?? []).map((g) => ({
                    value: g.id,
                    label: g.name,
                  }))}
                  value={effectiveMcpId}
                  onValueChange={handleMcpSelect}
                  placeholder="Select gateway"
                />
              ) : null
            }
          >
            {client && selectedMcp && effectiveMcpId && (
              <McpClientInstructions
                client={client}
                gatewayId={effectiveMcpId}
                gatewaySlug={selectedMcp.slug ?? effectiveMcpId}
                gatewayName={selectedMcp.name}
                baseUrl={baseUrl}
              />
            )}
            {client && !effectiveMcpId && (
              <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                No MCP gateways available.{" "}
                <Link
                  href="/mcp/gateways"
                  className="underline hover:text-foreground"
                >
                  Create one
                </Link>{" "}
                to continue.
              </div>
            )}
          </StepCard>
        </div>
      )}

      {/* Step 3 — LLM Proxy */}
      {client && canReadLlmProxy && (
        <div
          key={`proxy-${client.id}`}
          className="grid gap-3.5 animate-in fade-in slide-in-from-bottom-2 duration-500 [animation-delay:140ms] [animation-fill-mode:backwards]"
        >
          <SectionHeading step={2} title="Route through the LLM Proxy" />
          <StepCard
            hideStatus
            pinned
            state={stepState}
            expanded
            actions={
              client &&
              client.proxy.kind !== "unsupported" &&
              (llmProxies?.length ?? 0) > 1 ? (
                <SearchableSelect
                  options={(llmProxies ?? []).map((p) => ({
                    value: p.id,
                    label: p.name,
                  }))}
                  value={effectiveProxyId}
                  onValueChange={handleProxySelect}
                  placeholder="Select proxy"
                />
              ) : null
            }
          >
            {client && effectiveProxyId && (
              <ProxyClientInstructions
                client={client}
                profileId={effectiveProxyId}
                profileName={
                  llmProxies?.find((p) => p.id === effectiveProxyId)?.name ?? ""
                }
                shownProviders={shownProviders}
                baseUrl={baseUrl}
              />
            )}
            {client && !effectiveProxyId && (
              <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                No LLM proxies available.{" "}
                <Link
                  href="/llm/proxies"
                  className="underline hover:text-foreground"
                >
                  Create one
                </Link>{" "}
                to continue.
              </div>
            )}
          </StepCard>
        </div>
      )}

      {/* Step 4 — Skills marketplace (no-ops when feature off or non-admin) */}
      {client && (
        <div
          key={`skills-${client.id}`}
          className="grid gap-3.5 animate-in fade-in slide-in-from-bottom-2 duration-500 [animation-delay:280ms] [animation-fill-mode:backwards]"
        >
          <SkillsMarketplaceStep client={client} />
        </div>
      )}
    </div>
  );
}
