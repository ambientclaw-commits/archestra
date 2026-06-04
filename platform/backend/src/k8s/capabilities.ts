import type * as k8s from "@kubernetes/client-node";
import logger from "@/logging";
import type { K8sCapabilities } from "@/types";
import { createK8sClients, isK8sNotFoundError, loadKubeConfig } from "./shared";

// === Public API ===

export async function getK8sCapabilities(): Promise<K8sCapabilities> {
  const cached = getValidCacheEntry(globalCapabilitiesCache);
  if (cached) return cached;

  try {
    const { kubeConfig, namespace } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);
    const capabilities = await getK8sCapabilitiesFromApi({
      customObjectsApi: clients.customObjectsApi,
      authApi: clients.authApi,
      namespace,
    });
    globalCapabilitiesCache = createCacheEntry(capabilities);
    return capabilities;
  } catch (error) {
    logger.warn({ err: error }, "Failed to inspect Kubernetes capabilities");
    return unavailableCapabilities();
  }
}

export async function getK8sCapabilitiesFromApi(params: {
  customObjectsApi: k8s.CustomObjectsApi;
  authApi: k8s.AuthorizationV1Api;
  namespace: string;
}): Promise<K8sCapabilities> {
  const cached = getValidCacheEntry(
    apiCapabilitiesCache.get(params.customObjectsApi)?.get(params.namespace),
  );
  if (cached) return cached;

  const [
    ciliumNetworkPolicy,
    gkeFqdnNetworkPolicy,
    awsApplicationNetworkPolicy,
  ] = await Promise.all([
    hasManageableCustomPolicyResource({
      customObjectsApi: params.customObjectsApi,
      authApi: params.authApi,
      namespace: params.namespace,
      group: "cilium.io",
      version: "v2",
      resource: "ciliumnetworkpolicies",
      logName: "Cilium",
    }),
    hasManageableCustomPolicyResource({
      customObjectsApi: params.customObjectsApi,
      authApi: params.authApi,
      namespace: params.namespace,
      group: "networking.gke.io",
      version: "v1alpha1",
      resource: "fqdnnetworkpolicies",
      logName: "GKE FQDN",
    }),
    hasManageableCustomPolicyResource({
      customObjectsApi: params.customObjectsApi,
      authApi: params.authApi,
      namespace: params.namespace,
      group: "networking.k8s.aws",
      version: "v1alpha1",
      resource: "applicationnetworkpolicies",
      logName: "AWS ApplicationNetworkPolicy",
    }),
  ]);
  const provider = ciliumNetworkPolicy
    ? "cilium"
    : gkeFqdnNetworkPolicy
      ? "gke-fqdn"
      : awsApplicationNetworkPolicy
        ? "aws-application-network-policy"
        : "kubernetes";
  const supportsFqdn =
    ciliumNetworkPolicy || gkeFqdnNetworkPolicy || awsApplicationNetworkPolicy;

  const capabilities: K8sCapabilities = {
    networkPolicy: {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy,
      gkeFqdnNetworkPolicy,
      awsApplicationNetworkPolicy,
      provider,
      supportsFqdn,
      supportsHttpMethods: false,
      message: capabilityMessage({
        ciliumNetworkPolicy,
        gkeFqdnNetworkPolicy,
        awsApplicationNetworkPolicy,
        supportsFqdn,
      }),
    },
  };
  const apiCache =
    apiCapabilitiesCache.get(params.customObjectsApi) ?? new Map();
  apiCache.set(params.namespace, createCacheEntry(capabilities));
  apiCapabilitiesCache.set(params.customObjectsApi, apiCache);
  return capabilities;
}

/** @internal exported for tests */
export function clearK8sCapabilitiesCache(): void {
  globalCapabilitiesCache = null;
  apiCapabilitiesCache = new WeakMap();
}

// === Internal helpers ===

const K8S_CAPABILITIES_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  value: K8sCapabilities;
};

let globalCapabilitiesCache: CacheEntry | null = null;
let apiCapabilitiesCache = new WeakMap<
  k8s.CustomObjectsApi,
  Map<string, CacheEntry>
>();

const CUSTOM_POLICY_MANAGEMENT_VERBS = ["create", "update", "delete"] as const;

function createCacheEntry(value: K8sCapabilities): CacheEntry {
  return {
    value,
    expiresAt: Date.now() + K8S_CAPABILITIES_CACHE_TTL_MS,
  };
}

function getValidCacheEntry(entry: CacheEntry | null | undefined) {
  if (!entry || entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.value;
}

async function hasManageableCustomPolicyResource(params: {
  customObjectsApi: k8s.CustomObjectsApi;
  authApi: k8s.AuthorizationV1Api;
  namespace: string;
  group: string;
  version: string;
  resource: string;
  logName: string;
}): Promise<boolean> {
  const exists = await hasCustomPolicyResource(params);
  if (!exists) {
    return false;
  }

  const accessResults = await Promise.all(
    CUSTOM_POLICY_MANAGEMENT_VERBS.map(async (verb) => ({
      verb,
      allowed: await canManageCustomPolicyResource({ ...params, verb }),
    })),
  );
  const deniedVerb = accessResults.find((result) => !result.allowed)?.verb;
  if (deniedVerb) {
    logger.warn(
      {
        namespace: params.namespace,
        apiGroup: params.group,
        resource: params.resource,
        verb: deniedVerb,
      },
      `${params.logName} Kubernetes API resource detected, but the platform service account cannot manage it`,
    );
    return false;
  }

  return true;
}

async function hasCustomPolicyResource(params: {
  customObjectsApi: k8s.CustomObjectsApi;
  group: string;
  version: string;
  resource: string;
  logName: string;
}): Promise<boolean> {
  try {
    const resourceList = await params.customObjectsApi.getAPIResources({
      group: params.group,
      version: params.version,
    });
    return (
      resourceList.resources?.some(
        (resource) => resource.name === params.resource,
      ) ?? false
    );
  } catch (error) {
    if (isK8sNotFoundError(error)) {
      return false;
    }
    logger.warn(
      { err: error },
      `Failed to inspect ${params.logName} Kubernetes API resources`,
    );
    return false;
  }
}

async function canManageCustomPolicyResource(params: {
  authApi: k8s.AuthorizationV1Api;
  namespace: string;
  group: string;
  resource: string;
  verb: (typeof CUSTOM_POLICY_MANAGEMENT_VERBS)[number];
}): Promise<boolean> {
  try {
    const review = await params.authApi.createSelfSubjectAccessReview({
      body: {
        spec: {
          resourceAttributes: {
            namespace: params.namespace,
            verb: params.verb,
            group: params.group,
            resource: params.resource,
          },
        },
      },
    });
    return review.status?.allowed ?? false;
  } catch (error) {
    logger.warn(
      {
        err: error,
        namespace: params.namespace,
        apiGroup: params.group,
        resource: params.resource,
        verb: params.verb,
      },
      "Failed to inspect Kubernetes service account access",
    );
    return false;
  }
}

function capabilityMessage(params: {
  ciliumNetworkPolicy: boolean;
  gkeFqdnNetworkPolicy: boolean;
  awsApplicationNetworkPolicy: boolean;
  supportsFqdn: boolean;
}): string {
  if (params.ciliumNetworkPolicy) {
    return "CiliumNetworkPolicy API detected. Domain allowlists can be enforced by Cilium.";
  }
  if (params.gkeFqdnNetworkPolicy) {
    return "GKE FQDNNetworkPolicy API detected. Domain allowlists can be enforced by GKE.";
  }
  if (params.awsApplicationNetworkPolicy) {
    return "AWS ApplicationNetworkPolicy API detected. Domain allowlists can be enforced by EKS Auto Mode.";
  }
  if (!params.supportsFqdn) {
    return "No supported FQDN policy provider detected. Kubernetes NetworkPolicy only enforces IP/CIDR egress.";
  }
  return "Network policy capabilities detected.";
}

function unavailableCapabilities(): K8sCapabilities {
  return {
    networkPolicy: {
      kubernetesNetworkPolicy: false,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "none",
      supportsFqdn: false,
      supportsHttpMethods: false,
      message:
        "Kubernetes capabilities could not be inspected. Network policy enforcement is unavailable until Kubernetes access is configured.",
    },
  };
}
