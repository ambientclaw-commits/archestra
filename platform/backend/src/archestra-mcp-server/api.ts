import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_API_SHORT_NAME } from "@shared";
import { z } from "zod";
import { loopbackGateway } from "@/auth";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
} from "./helpers";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const ApiToolArgsSchema = z
  .object({
    method: z
      .enum(HTTP_METHODS)
      .describe("HTTP method, e.g. GET to read or POST to create."),
    path: z
      .string()
      .describe(
        "API path starting with /api/, e.g. /api/agents or /api/agents/<id>.",
      ),
    query: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional query-string parameters."),
    body: z
      .unknown()
      .optional()
      .describe("Optional JSON request body for write methods."),
  })
  .strict();

const DESCRIPTION = `Call the Archestra platform's own REST API — the same API the web UI uses.

Drive any platform operation (agents, MCP servers, tools, policies, knowledge, limits, members, …) by issuing the underlying HTTP request instead of a bespoke tool. Consult the OpenAPI schema at GET /openapi.json to discover paths, parameters, and request/response shapes.

The call runs with your own permissions: if you can do it in the UI, you can do it here; otherwise it returns 403. Reads (GET) run directly; writes may require human approval per policy.`;

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_API_SHORT_NAME,
    title: "Archestra API",
    description: DESCRIPTION,
    schema: ApiToolArgsSchema,
    async handler({ args, context }): Promise<CallToolResult> {
      if (!context.userId || !context.organizationId) {
        return errorResult(
          "The Archestra API tool requires an authenticated user context; it is unavailable to autonomous sessions without a user.",
        );
      }

      // Restrict to the RBAC-protected API surface (plus the OpenAPI schema for
      // discovery). This deliberately excludes auth-skipping routes such as the
      // /v1/* LLM proxies, which would otherwise bypass the loopback RBAC.
      if (args.path !== "/openapi.json" && !args.path.startsWith("/api/")) {
        return errorResult("path must be /openapi.json or start with /api/.");
      }

      try {
        const response = await loopbackGateway.request({
          method: args.method,
          path: args.path,
          query: args.query,
          body: args.body,
          userId: context.userId,
          organizationId: context.organizationId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `HTTP ${response.status}\n${JSON.stringify(response.body, null, 2)}`,
            },
          ],
          structuredContent: { status: response.status, body: response.body },
          isError: response.status >= 400,
        };
      } catch (error) {
        return catchError(error, "calling the Archestra API");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
