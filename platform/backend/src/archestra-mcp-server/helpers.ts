import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type ArchestraToolFullName,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  type McpToolError,
} from "@shared";
import { ZodError, type ZodType, z } from "zod";
import logger from "@/logging";
import type { ArchestraContext } from "./types";

export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  // Match "aborted" as a whole word to avoid false positives
  // (e.g., "aborting transaction due to constraint violation")
  return /\baborted?\b/i.test(error.message);
}

type ArchestraToolHandler<TSchema extends ZodType = ZodType> = (params: {
  args: z.infer<TSchema>;
  context: ArchestraContext;
  toolName: string;
}) => Promise<CallToolResult>;

type ArchestraToolDefinition<
  ShortName extends ArchestraToolShortName = ArchestraToolShortName,
  TSchema extends ZodType = ZodType,
> = {
  shortName: ShortName;
  title: string;
  description: string;
  schema: TSchema;
  outputSchema?: ZodType;
  handler: ArchestraToolHandler<TSchema>;
  invoke: ArchestraToolHandler;
};

export type ArchestraRuntimeToolEntry = {
  schema: ZodType;
  outputSchema?: ZodType | undefined;
  invoke: (params: {
    args: unknown;
    context: ArchestraContext;
    toolName: string;
  }) => Promise<CallToolResult>;
};

type ArchestraToolDefinitionInput<
  ShortName extends ArchestraToolShortName = ArchestraToolShortName,
  TSchema extends ZodType = ZodType,
> = Omit<ArchestraToolDefinition<ShortName, TSchema>, "invoke">;

export const EmptyToolArgsSchema = z.strictObject({});

export function successResult(text: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    isError: false,
  };
}

export function structuredSuccessResult(
  structuredContent: Record<string, unknown>,
  text = JSON.stringify(structuredContent, null, 2),
): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
    isError: false,
  };
}

export function structuredToolErrorResult(params: {
  error: McpToolError;
  text?: string;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}): CallToolResult {
  // Keep the structured error in both MCP-native fields and text content:
  // clients may see only streamed text, persisted output, or structured content.
  const structuredContent = {
    ...params.structuredContent,
    archestraError: params.error,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: params.text ?? `Error: ${params.error.message}`,
      },
    ],
    structuredContent,
    _meta: {
      archestraError: params.error,
    },
    isError: params.isError ?? true,
  };
}

function createToolDefinition(params: {
  name: string;
  title: string;
  description: string;
  schema: ZodType;
  outputSchema?: ZodType;
}): Tool {
  return {
    name: params.name,
    title: params.title,
    description: params.description,
    inputSchema: z.toJSONSchema(params.schema, {
      io: "input",
    }) as Tool["inputSchema"],
    ...(params.outputSchema
      ? {
          outputSchema: z.toJSONSchema(params.outputSchema, {
            io: "output",
          }) as Tool["outputSchema"],
        }
      : {}),
    annotations: {},
    _meta: {},
  };
}

export function defineArchestraTool<
  const ShortName extends ArchestraToolShortName,
  const TSchema extends ZodType,
  const TOutputSchema extends ZodType | undefined = undefined,
>(definition: {
  shortName: ShortName;
  title: string;
  description: string;
  schema: TSchema;
  outputSchema?: TOutputSchema;
  handler: ArchestraToolHandler<TSchema>;
}): ArchestraToolDefinition<ShortName, TSchema> & {
  outputSchema?: TOutputSchema;
} {
  return {
    ...definition,
    invoke: definition.handler as unknown as ArchestraToolHandler,
  };
}

export function defineArchestraTools<
  const Definitions extends readonly ArchestraToolDefinitionInput[],
>(definitions: Definitions) {
  type ShortName = Definitions[number]["shortName"];
  type FullName<Name extends ArchestraToolShortName> =
    ArchestraToolFullName<Name>;

  const toolShortNames = definitions.map(
    (definition) => definition.shortName,
  ) as {
    [Index in keyof Definitions]: Definitions[Index]["shortName"];
  };

  const toolFullNames: Record<string, string> = {};
  const toolArgsSchemas: Record<string, ZodType> = {};
  const toolOutputSchemas: Record<string, ZodType> = {};
  const toolEntries: Record<string, ArchestraRuntimeToolEntry> = {};

  for (const definition of definitions) {
    const shortName = definition.shortName as ShortName;
    const fullName = getArchestraToolFullName(
      definition.shortName,
    ) as FullName<ShortName>;

    toolFullNames[shortName] = fullName;
    toolArgsSchemas[fullName] = definition.schema;
    if (definition.outputSchema) {
      toolOutputSchemas[fullName] = definition.outputSchema;
    }
    toolEntries[fullName] = {
      schema: definition.schema,
      outputSchema: definition.outputSchema,
      invoke:
        (definition as Partial<ArchestraToolDefinition>).invoke ??
        (definition.handler as unknown as ArchestraToolHandler),
    };
  }

  const tools = definitions.map((definition) =>
    createToolDefinition({
      name: toolFullNames[definition.shortName as ShortName],
      title: definition.title,
      description: definition.description,
      schema: definition.schema,
      outputSchema: definition.outputSchema,
    }),
  );

  return {
    toolShortNames,
    toolFullNames: toolFullNames as {
      [Definition in Definitions[number] as Definition["shortName"]]: FullName<
        Definition["shortName"]
      >;
    },
    toolArgsSchemas: toolArgsSchemas as {
      [Definition in Definitions[number] as FullName<
        Definition["shortName"]
      >]: Definition["schema"];
    },
    toolOutputSchemas: toolOutputSchemas as Partial<
      Record<FullName<ShortName>, ZodType>
    >,
    toolEntries: toolEntries as {
      [Definition in Definitions[number] as FullName<
        Definition["shortName"]
      >]: {
        schema: Definition["schema"];
        outputSchema: Definition["outputSchema"];
        invoke: ArchestraRuntimeToolEntry["invoke"];
      };
    },
    tools,
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function catchError(error: unknown, action: string): CallToolResult {
  logger.error({ err: error }, `Error ${action}`);
  // Zod validation errors are safe to surface — they describe user input issues.
  if (error instanceof ZodError) {
    return errorResult(
      `Validation error while ${action}: ${formatZodError(error)}`,
    );
  }
  // Unique constraint violations are user-actionable (e.g., duplicate name).
  if (isUniqueConstraintError(error)) {
    return errorResult(
      `A record with the same value already exists (${action})`,
    );
  }
  // All other errors get a generic message to avoid leaking internal details.
  return errorResult(`An internal error occurred while ${action}`);
}

// === Internal helpers ===

export function formatZodError(error: ZodError): string {
  return error.issues.map(formatZodIssue).join("; ");
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // PostgreSQL unique_violation code
  return "code" in error && (error as { code: string }).code === "23505";
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = formatIssuePath(issue.path);
  return path ? `${path}: ${issue.message}` : issue.message;
}

function formatIssuePath(path: PropertyKey[] | undefined): string {
  if (!path || path.length === 0) {
    return "";
  }

  return path
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }

      const key = String(segment);
      return index === 0 ? key : `.${key}`;
    })
    .join("");
}
