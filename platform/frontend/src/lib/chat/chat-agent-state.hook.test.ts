import type { archestraApiTypes } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { resolveChatAgentState } from "./chat-agent-state.hook";

describe("resolveChatAgentState", () => {
  test("prefers the conversation agentId when present", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: "agent-b",
        agent: makeConversationAgent("agent-b", "Agent B"),
      }),
      initialAgentId: "agent-a",
    });

    expect(state.conversationAgentId).toBe("agent-b");
    expect(state.activeAgentId).toBe("agent-b");
    expect(state.promptAgentId).toBe("agent-b");
  });

  test("falls back to the conversation agent object id when agentId is missing", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: null,
        agent: makeConversationAgent("agent-b", "Agent B"),
      }),
      initialAgentId: "agent-a",
    });

    expect(state.conversationAgentId).toBe("agent-b");
    expect(state.activeAgentId).toBe("agent-b");
    expect(state.promptAgentId).toBe("agent-b");
  });

  test("falls back to the initial agent when the conversation agent is unavailable", () => {
    const state = resolveChatAgentState({
      conversation: makeConversation({
        agentId: null,
        agent: null,
      }),
      initialAgentId: "agent-a",
    });

    expect(state.conversationAgentId).toBeNull();
    expect(state.activeAgentId).toBe("agent-a");
    expect(state.promptAgentId).toBe("agent-a");
  });
});

function makeConversationAgent(id: string, name: string) {
  return {
    id,
    name,
    systemPrompt: null,
    agentType: "agent" as const,
    toolExposureMode: "full" as const,
    llmApiKeyId: null,
  };
}

function makeConversation(
  overrides: Partial<
    archestraApiTypes.GetChatConversationResponses["200"]
  > = {},
): archestraApiTypes.GetChatConversationResponses["200"] {
  return {
    id: "conversation-1",
    userId: "user-1",
    organizationId: "org-1",
    agentId: "agent-a",
    chatApiKeyId: null,
    title: "Test",
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    modelId: null,
    hasCustomToolSelection: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    lastMessageAt: "2026-03-19T00:00:00.000Z",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
    agent: {
      id: "agent-a",
      name: "Agent A",
      systemPrompt: null,
      agentType: "agent",
      toolExposureMode: "full",
      llmApiKeyId: null,
    },
    share: null,
    messages: [],
    chatErrors: [],
    ...overrides,
    compactions: overrides.compactions ?? [],
  };
}
