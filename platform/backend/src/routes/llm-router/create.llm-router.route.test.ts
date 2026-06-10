import { ModelModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

async function makeModel(modelId: string, supportsToolCalling = true) {
  return ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    supportsToolCalling,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
}

describe("POST /api/llm-routers", () => {
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

  test("creates a router from an org-owned key and models", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id);
    const cheap = await makeModel("claude-haiku-4-5");
    const premium = await makeModel("claude-opus-4-8");

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-routers",
      payload: {
        name: "Org router",
        mode: "balanced",
        cheapModelId: cheap.id,
        cheapApiKeyId: key.id,
        premiumModelId: premium.id,
        premiumApiKeyId: key.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Org router",
      mode: "balanced",
      organizationId,
      cheapModelId: cheap.id,
      premiumModelId: premium.id,
    });
  });

  test("rejects an API key that belongs to another organization", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const secret = await makeSecret({ secret: { apiKey: "sk" } });
    const foreignKey = await makeLlmProviderApiKey(otherOrgId, secret.id);
    const cheap = await makeModel("claude-haiku-4-5");
    const premium = await makeModel("claude-opus-4-8");

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-routers",
      payload: {
        name: "Cross-org router",
        mode: "balanced",
        cheapModelId: cheap.id,
        cheapApiKeyId: foreignKey.id,
        premiumModelId: premium.id,
        premiumApiKeyId: foreignKey.id,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  test("rejects an unknown model id", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id);
    const premium = await makeModel("claude-opus-4-8");

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-routers",
      payload: {
        name: "Bad model router",
        mode: "balanced",
        cheapModelId: crypto.randomUUID(),
        cheapApiKeyId: key.id,
        premiumModelId: premium.id,
        premiumApiKeyId: key.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
