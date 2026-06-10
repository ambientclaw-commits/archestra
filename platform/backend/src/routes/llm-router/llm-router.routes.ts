import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LlmProviderApiKeyModel, LlmRouterModel, ModelModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertLlmRouterSchema,
  SelectLlmRouterSchema,
  UpdateLlmRouterSchema,
  UuidIdSchema,
} from "@/types";

const CreateLlmRouterBodySchema = InsertLlmRouterSchema.omit({
  organizationId: true,
});

/**
 * Ensure the candidate model + API-key IDs belong to the caller's organization
 * before they are persisted (the proxy/classifier later dereference them with
 * the stored values, so an unvalidated cross-org key would be usable here).
 */
async function validateRouterReferences(params: {
  organizationId: string;
  cheapApiKeyId?: string | null;
  premiumApiKeyId?: string | null;
  cheapModelId?: string | null;
  premiumModelId?: string | null;
}): Promise<void> {
  for (const apiKeyId of [params.cheapApiKeyId, params.premiumApiKeyId]) {
    if (!apiKeyId) continue;
    const key = await LlmProviderApiKeyModel.findById(apiKeyId);
    if (!key || key.organizationId !== params.organizationId) {
      throw new ApiError(404, "Provider API key not found");
    }
  }
  for (const modelId of [params.cheapModelId, params.premiumModelId]) {
    if (!modelId) continue;
    const model = await ModelModel.findById(modelId);
    if (!model) {
      throw new ApiError(400, "Model not found");
    }
  }
}

const llmRouterRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-routers",
    {
      schema: {
        operationId: RouteId.GetLlmRouters,
        description: "Get all smart routers for the organization",
        tags: ["LLM Routers"],
        response: constructResponseSchema(z.array(SelectLlmRouterSchema)),
      },
    },
    async (request, reply) => {
      const routers = await LlmRouterModel.findByOrganizationId(
        request.organizationId,
      );
      return reply.send(routers);
    },
  );

  fastify.post(
    "/api/llm-routers",
    {
      schema: {
        operationId: RouteId.CreateLlmRouter,
        description: "Create a smart router for the organization",
        tags: ["LLM Routers"],
        body: CreateLlmRouterBodySchema,
        response: constructResponseSchema(SelectLlmRouterSchema),
      },
    },
    async (request, reply) => {
      await validateRouterReferences({
        organizationId: request.organizationId,
        ...request.body,
      });
      const router = await LlmRouterModel.create({
        ...request.body,
        organizationId: request.organizationId,
      });
      return reply.send(router);
    },
  );

  fastify.get(
    "/api/llm-routers/:id",
    {
      schema: {
        operationId: RouteId.GetLlmRouter,
        description: "Get a smart router by ID",
        tags: ["LLM Routers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectLlmRouterSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const router = await LlmRouterModel.findById(id);
      if (!router || router.organizationId !== organizationId) {
        throw new ApiError(404, "Smart router not found");
      }
      return reply.send(router);
    },
  );

  fastify.put(
    "/api/llm-routers/:id",
    {
      schema: {
        operationId: RouteId.UpdateLlmRouter,
        description: "Update a smart router",
        tags: ["LLM Routers"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateLlmRouterSchema.partial(),
        response: constructResponseSchema(SelectLlmRouterSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const existing = await LlmRouterModel.findById(id);
      if (!existing || existing.organizationId !== organizationId) {
        throw new ApiError(404, "Smart router not found");
      }

      await validateRouterReferences({ organizationId, ...body });

      const router = await LlmRouterModel.update(id, body);
      if (!router) {
        throw new ApiError(404, "Smart router not found");
      }
      return reply.send(router);
    },
  );

  fastify.delete(
    "/api/llm-routers/:id",
    {
      schema: {
        operationId: RouteId.DeleteLlmRouter,
        description: "Delete a smart router",
        tags: ["LLM Routers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const existing = await LlmRouterModel.findById(id);
      if (!existing || existing.organizationId !== organizationId) {
        throw new ApiError(404, "Smart router not found");
      }

      const deleted = await LlmRouterModel.delete(id);
      if (!deleted) {
        throw new ApiError(404, "Smart router not found");
      }
      return reply.send({ success: true });
    },
  );
};

export default llmRouterRoutes;
