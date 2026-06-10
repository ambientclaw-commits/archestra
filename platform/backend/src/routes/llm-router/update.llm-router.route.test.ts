import { LlmRouterModel, ModelModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

type MakeSecret = (opts: {
  secret: Record<string, unknown>;
}) => Promise<{ id: string }>;
type MakeKey = (orgId: string, secretId: string) => Promise<{ id: string }>;

async function makeModel(modelId: string) {
  return ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    supportsToolCalling: true,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
}

async function seedRouter(params: {
  organizationId: string;
  makeSecret: MakeSecret;
  makeKey: MakeKey;
}) {
  const secret = await params.makeSecret({ secret: { apiKey: "sk" } });
  const key = await params.makeKey(params.organizationId, secret.id);
  const cheap = await makeModel(`haiku-${crypto.randomUUID().slice(0, 6)}`);
  const premium = await makeModel(`opus-${crypto.randomUUID().slice(0, 6)}`);
  const router = await LlmRouterModel.create({
    organizationId: params.organizationId,
    name: "Router",
    mode: "balanced",
    enabled: true,
    cheapModelId: cheap.id,
    cheapApiKeyId: key.id,
    premiumModelId: premium.id,
    premiumApiKeyId: key.id,
  });
  return { router, keyId: key.id };
}

describe("PUT /api/llm-routers/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: llmRouterRoutes } = await import("./llm-router.routes");
    await app.register(llmRouterRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("updates a router owned by the caller's organization", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { router } = await seedRouter({
      organizationId,
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/llm-routers/${router.id}`,
      payload: { name: "Renamed", mode: "quality" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Renamed", mode: "quality" });
  });

  test("returns 404 for a router in another organization", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const { router } = await seedRouter({
      organizationId: otherOrgId,
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/llm-routers/${router.id}`,
      payload: { name: "Hijacked" },
    });

    expect(response.statusCode).toBe(404);
  });

  test("rejects updating to an API key from another organization", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { router } = await seedRouter({
      organizationId,
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });
    const otherOrgId = (await makeOrganization()).id;
    const foreignSecret = await makeSecret({ secret: { apiKey: "sk" } });
    const foreignKey = await makeLlmProviderApiKey(
      otherOrgId,
      foreignSecret.id,
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/llm-routers/${router.id}`,
      payload: { cheapApiKeyId: foreignKey.id },
    });

    expect(response.statusCode).toBe(404);
  });
});
