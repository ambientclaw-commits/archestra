import {
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { ConversationModel, ScheduleTriggerRunModel } from "@/models";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

// === Constants ===

const TodoItemSchema = z
  .object({
    id: z.number().int().describe("Unique identifier for the todo item."),
    content: z
      .string()
      .describe("The content or description of the todo item."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("The current status of the todo item."),
  })
  .strict();

const TodoWriteOutputSchema = z.object({
  success: z.literal(true).describe("Whether the write succeeded."),
  todoCount: z
    .number()
    .int()
    .nonnegative()
    .describe("How many todo items were written."),
});

const ArtifactWriteOutputSchema = z.object({
  success: z.literal(true).describe("Whether the artifact write succeeded."),
  characterCount: z
    .number()
    .int()
    .nonnegative()
    .describe("The number of characters written to the artifact."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_TODO_WRITE_SHORT_NAME,
    title: "Write Todos",
    description:
      "Write todos to the current conversation. You have access to this tool to help you manage and plan tasks. Use it VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress. This tool is also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable. It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
    schema: z
      .object({
        todos: z
          .array(TodoItemSchema)
          .describe("Array of todo items to write to the conversation."),
      })
      .strict(),
    outputSchema: TodoWriteOutputSchema,
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, todoArgs: args },
        "todo_write tool called",
      );

      try {
        return structuredSuccessResult(
          { success: true, todoCount: args.todos.length },
          `Successfully wrote ${args.todos.length} todo item(s) to the conversation`,
        );
      } catch (error) {
        return catchError(error, "writing todos");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_ARTIFACT_WRITE_SHORT_NAME,
    title: "Write Artifact",
    description:
      "Write or update a markdown artifact for the current conversation. Use this tool to maintain a persistent document that evolves throughout the conversation. The artifact should contain well-structured markdown content that can be referenced and updated as the conversation progresses. Each call to this tool completely replaces the existing artifact content. " +
      "Mermaid diagrams: Use ```mermaid blocks. " +
      "Supports: Headers, emphasis, lists, links, images, code blocks, tables, blockquotes, task lists, mermaid diagrams.",
    schema: z
      .object({
        content: z
          .string()
          .min(1)
          .describe(
            "The markdown content to write to the conversation artifact. This completely replaces any existing artifact content.",
          ),
      })
      .strict(),
    outputSchema: ArtifactWriteOutputSchema,
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        {
          agentId: contextAgent.id,
          contentLength: args.content.length,
          scheduleTriggerRunId: context.scheduleTriggerRunId ?? null,
          conversationId: context.conversationId ?? null,
          userId: context.userId ?? null,
          organizationId: context.organizationId ?? null,
        },
        "artifact_write tool called",
      );

      try {
        let successMessage = `Successfully updated artifact (${args.content.length} characters)`;

        // Scheduled run context — write to the run (conversationId is a
        // synthetic isolation key, not a real DB conversation)
        if (context.scheduleTriggerRunId) {
          const updated = await ScheduleTriggerRunModel.setArtifact(
            context.scheduleTriggerRunId,
            args.content,
          );

          if (!updated) {
            return errorResult(
              "Failed to update scheduled run artifact. The run may no longer exist.",
            );
          }
        } else if (context.chatOpsBindingId) {
          logger.info(
            {
              agentId: contextAgent.id,
              chatOpsBindingId: context.chatOpsBindingId,
              chatOpsThreadId: context.chatOpsThreadId ?? null,
            },
            "artifact_write completed in chatops context without persistent artifact storage",
          );
          successMessage = `Accepted artifact content (${args.content.length} characters). ChatOps does not persist conversation artifacts, so include relevant artifact content in the final response.`;
        } else if (
          context.conversationId &&
          context.userId &&
          context.organizationId
        ) {
          const updated = await ConversationModel.update(
            context.conversationId,
            context.userId,
            context.organizationId,
            { artifact: args.content },
          );

          if (!updated) {
            return errorResult(
              "Failed to update conversation artifact. The conversation may not exist or you may not have permission to update it.",
            );
          }
        } else {
          return errorResult(
            "This tool requires conversation context. It can only be used within an active chat conversation or scheduled run.",
          );
        }

        return structuredSuccessResult(
          { success: true, characterCount: args.content.length },
          successMessage,
        );
      } catch (error) {
        return catchError(error, "writing artifact");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;
