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
  name: string;
  makeSecret: MakeSecret;
  makeKey: MakeKey;
}) {
  const secret = await params.makeSecret({ secret: { apiKey: "sk" } });
  const key = await params.makeKey(params.organizationId, secret.id);
  const cheap = await makeModel(`haiku-${crypto.randomUUID().slice(0, 6)}`);
  const premium = await makeModel(`opus-${crypto.randomUUID().slice(0, 6)}`);
  return LlmRouterModel.create({
    organizationId: params.organizationId,
    name: params.name,
    mode: "balanced",
    enabled: true,
    cheapModelId: cheap.id,
    cheapApiKeyId: key.id,
    premiumModelId: premium.id,
    premiumApiKeyId: key.id,
  });
}

describe("GET /api/llm-routers", () => {
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

  test("lists only the caller's organization routers", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const mine = await seedRouter({
      organizationId,
      name: "Mine",
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });
    await seedRouter({
      organizationId: otherOrgId,
      name: "Theirs",
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-routers",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(mine.id);
  });

  test("returns a router by id for the owning organization", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const router = await seedRouter({
      organizationId,
      name: "Mine",
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-routers/${router.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(router.id);
  });

  test("returns 404 for a router in another organization", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const foreign = await seedRouter({
      organizationId: otherOrgId,
      name: "Theirs",
      makeSecret,
      makeKey: makeLlmProviderApiKey,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-routers/${foreign.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for a nonexistent id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/llm-routers/${crypto.randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
  });
});
