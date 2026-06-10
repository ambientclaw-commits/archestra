import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { InsertLlmRouter, LlmRouter, UpdateLlmRouter } from "@/types";

class LlmRouterModel {
  static async create(data: InsertLlmRouter): Promise<LlmRouter> {
    const [router] = await db
      .insert(schema.llmRoutersTable)
      .values(data)
      .returning();

    logger.debug({ routerId: router.id }, "LlmRouterModel.create: created");
    return router;
  }

  static async findById(id: string): Promise<LlmRouter | null> {
    const [router] = await db
      .select()
      .from(schema.llmRoutersTable)
      .where(eq(schema.llmRoutersTable.id, id))
      .limit(1);

    return router ?? null;
  }

  static async findByOrganizationId(
    organizationId: string,
  ): Promise<LlmRouter[]> {
    return db
      .select()
      .from(schema.llmRoutersTable)
      .where(eq(schema.llmRoutersTable.organizationId, organizationId))
      .orderBy(asc(schema.llmRoutersTable.createdAt));
  }

  /** First enabled router for the organization, or null. */
  static async findEnabledByOrganizationId(
    organizationId: string,
  ): Promise<LlmRouter | null> {
    const [router] = await db
      .select()
      .from(schema.llmRoutersTable)
      .where(
        and(
          eq(schema.llmRoutersTable.organizationId, organizationId),
          eq(schema.llmRoutersTable.enabled, true),
        ),
      )
      .orderBy(asc(schema.llmRoutersTable.createdAt))
      .limit(1);

    return router ?? null;
  }

  static async update(
    id: string,
    data: Partial<UpdateLlmRouter>,
  ): Promise<LlmRouter | null> {
    const [router] = await db
      .update(schema.llmRoutersTable)
      .set(data)
      .where(eq(schema.llmRoutersTable.id, id))
      .returning();

    return router ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.llmRoutersTable)
      .where(eq(schema.llmRoutersTable.id, id))
      .returning({ id: schema.llmRoutersTable.id });

    return result.length > 0;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const router = await LlmRouterModel.findById(id);
    if (!router || router.organizationId !== organizationId) return null;

    return {
      id: router.id,
      organizationId: router.organizationId,
      name: router.name,
      enabled: router.enabled,
      cheapModelId: router.cheapModelId,
      cheapApiKeyId: router.cheapApiKeyId,
      premiumModelId: router.premiumModelId,
      premiumApiKeyId: router.premiumApiKeyId,
      mode: router.mode,
      createdAt: router.createdAt.toISOString(),
    };
  }
}

export default LlmRouterModel;
