import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearK8sCapabilitiesCache,
  getK8sCapabilitiesFromApi,
} from "./capabilities";

describe("Kubernetes capability inspection", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearK8sCapabilitiesCache();
  });

  test("reports Cilium FQDN support when the CiliumNetworkPolicy CRD exists and can be managed", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "cilium.io" ? [{ name: "ciliumnetworkpolicies" }] : [],
      })),
    };
    const authApi = createAuthApi();

    const capabilities = await getCapabilities(customObjectsApi, authApi);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledWith({
      group: "cilium.io",
      version: "v2",
    });
    expect(authApi.createSelfSubjectAccessReview).toHaveBeenCalledWith({
      body: {
        spec: {
          resourceAttributes: {
            namespace: "test-ns",
            verb: "delete",
            group: "cilium.io",
            resource: "ciliumnetworkpolicies",
          },
        },
      },
    });
    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: true,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "cilium",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("falls back to Kubernetes NetworkPolicy when Cilium delete access is denied", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "cilium.io" ? [{ name: "ciliumnetworkpolicies" }] : [],
      })),
    };
    const authApi = createAuthApi(({ verb }) => verb !== "delete");

    const capabilities = await getCapabilities(customObjectsApi, authApi);

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "kubernetes",
      supportsFqdn: false,
      supportsHttpMethods: false,
    });
  });

  test("falls back to Kubernetes NetworkPolicy when the Cilium CRD is absent", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn().mockRejectedValue({ statusCode: 404 }),
    };
    const authApi = createAuthApi();

    const capabilities = await getCapabilities(customObjectsApi, authApi);

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "kubernetes",
      supportsFqdn: false,
      supportsHttpMethods: false,
    });
  });

  test("reports GKE FQDN support when the FQDNNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "networking.gke.io"
            ? [{ name: "fqdnnetworkpolicies" }]
            : [],
      })),
    };
    const authApi = createAuthApi();

    const capabilities = await getCapabilities(customObjectsApi, authApi);

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: true,
      awsApplicationNetworkPolicy: false,
      provider: "gke-fqdn",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("reports AWS FQDN support when the ApplicationNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "networking.k8s.aws"
            ? [{ name: "applicationnetworkpolicies" }]
            : [],
      })),
    };
    const authApi = createAuthApi();

    const capabilities = await getCapabilities(customObjectsApi, authApi);

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: true,
      provider: "aws-application-network-policy",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("caches CRD inspection for the same Kubernetes API object", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };
    const authApi = createAuthApi();

    await getCapabilities(customObjectsApi, authApi);
    await getCapabilities(customObjectsApi, authApi);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(3);
  });

  test("caches CRD inspection separately per namespace", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };
    const authApi = createAuthApi();

    await getCapabilities(customObjectsApi, authApi, "first-ns");
    await getCapabilities(customObjectsApi, authApi, "second-ns");

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(6);
  });

  test("reprobes after the capability cache TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };
    const authApi = createAuthApi();

    await getCapabilities(customObjectsApi, authApi);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getCapabilities(customObjectsApi, authApi);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(6);
  });
});

function createAuthApi(
  isAllowed: (attributes: {
    namespace: string;
    verb: string;
    group: string;
    resource: string;
  }) => boolean = () => true,
) {
  return {
    createSelfSubjectAccessReview: vi.fn(
      async (params: {
        body: {
          spec: {
            resourceAttributes: {
              namespace: string;
              verb: string;
              group: string;
              resource: string;
            };
          };
        };
      }) => ({
        status: {
          allowed: isAllowed(params.body.spec.resourceAttributes),
        },
      }),
    ),
  };
}

function getCapabilities(
  customObjectsApi: unknown,
  authApi: unknown,
  namespace = "test-ns",
) {
  return getK8sCapabilitiesFromApi({
    customObjectsApi: customObjectsApi as never,
    authApi: authApi as never,
    namespace,
  });
}
