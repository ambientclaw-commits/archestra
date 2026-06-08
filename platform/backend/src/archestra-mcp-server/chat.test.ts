// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { vi } from "vitest";
import { LlmProviderApiKeyModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("chat tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let userId: string;
  let organizationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      userId = user.id;
      organizationId = org.id;
      const secret = await makeSecret();
      const orgWideApiKey = await makeLlmProviderApiKey(
        organizationId,
        secret.id,
        {
          provider: "openai",
        },
      );
      vi.spyOn(LlmProviderApiKeyModel, "findById").mockImplementation(
        async (id) => {
          if (id === orgWideApiKey.id) {
            return orgWideApiKey;
          }
          return null;
        },
      );
      testAgent = await makeAgent({
        name: "Test Agent",
        agentType: "agent",
        organizationId,
      });
      mockContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        userId,
        organizationId,
      };
    },
  );

  test("todo_write returns error when todos is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__todo_write",
    );
    expect((result.content[0] as any).text).toContain("todos:");
  });

  test("todo_write succeeds with valid todos", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {
        todos: [
          { id: 1, content: "Test task", status: "pending" },
          { id: 2, content: "Another task", status: "completed" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ success: true, todoCount: 2 });
    expect((result.content[0] as any).text).toContain(
      "Successfully wrote 2 todo item(s)",
    );
  });

  test("artifact_write returns error when content is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__artifact_write",
    );
    expect((result.content[0] as any).text).toContain("content:");
  });

  test("artifact_write returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# My Artifact" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("artifact_write succeeds with real conversation context", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# Test Artifact\n\nSome **markdown** content." },
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      characterCount: "# Test Artifact\n\nSome **markdown** content.".length,
    });
    expect((result.content[0] as any).text).toContain(
      "Successfully updated artifact",
    );
  });

  test("artifact_write succeeds without conversation persistence in chatops context", async () => {
    const contextWithChatOps: ArchestraContext = {
      ...mockContext,
      conversationId: "synthetic-chatops-isolation-key",
      chatOpsBindingId: "chatops-binding-1",
      chatOpsThreadId: "thread-1",
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# ChatOps Artifact\n\nSome markdown content." },
      contextWithChatOps,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      characterCount: "# ChatOps Artifact\n\nSome markdown content.".length,
    });
    expect((result.content[0] as any).text).toContain(
      "ChatOps does not persist conversation artifacts",
    );
  });
});
