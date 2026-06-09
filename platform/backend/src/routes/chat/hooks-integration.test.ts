import { vi } from "vitest";
import config from "@/config";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import { ConversationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { activeChatRunService } from "@/services/active-chat-run";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const mockCreateUIMessageStream = vi.hoisted(() => vi.fn());
const mockCreateUIMessageStreamResponse = vi.hoisted(() => vi.fn());
const mockStreamText = vi.hoisted(() => vi.fn());
const mockCreateLLMModelForAgent = vi.hoisted(() => vi.fn());
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());
const mockExtractAndIngestDocuments = vi.hoisted(() => vi.fn());
const mockStartActiveChatSpan = vi.hoisted(() => vi.fn());
const mockCompactMessagesForChat = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    createUIMessageStream: mockCreateUIMessageStream,
    createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn(async (messages) => messages),
  };
});

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createLLMModelForAgent: mockCreateLLMModelForAgent,
  };
});

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/chat-mcp-client")>();
  return {
    ...actual,
    getChatMcpTools: mockGetChatMcpTools,
    getChatMcpToolUiResourceUris: mockGetChatMcpToolUiResourceUris,
  };
});

vi.mock("@/knowledge-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/knowledge-base")>();
  return {
    ...actual,
    extractAndIngestDocuments: mockExtractAndIngestDocuments,
  };
});

vi.mock("@/observability/tracing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/observability/tracing")>();
  return {
    ...actual,
    startActiveChatSpan: mockStartActiveChatSpan,
  };
});

vi.mock("./context-compaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-compaction")>();
  return {
    ...actual,
    compactMessagesForChat: mockCompactMessagesForChat,
  };
});

// The route's Stop-hook round loop only awaits the round callback when hooks
// are enabled (config.hooks.enabled folds in the agent-runtime requirement),
// so force it on for these lifecycle tests; fire() itself is mocked per test.
const originalHooksEnabled = config.hooks.enabled;

describe("POST /api/chat lifecycle hooks", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      (config.hooks as { enabled: boolean }).enabled = true;
      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const agent = await makeAgent({
        organizationId,
        name: "Router Agent",
        systemPrompt: "",
      });
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
      mockCompactMessagesForChat.mockImplementation(
        async ({ messages }: { messages: unknown[] }) => ({
          messages,
          status: "skipped",
          compaction: null,
          reason: "below_threshold",
        }),
      );
      mockStartActiveChatSpan.mockImplementation(
        async ({ callback }: { callback: () => Promise<Response> }) =>
          callback(),
      );
      mockStreamText.mockImplementation(() => ({
        fullStream: {
          [Symbol.asyncIterator]: () => {
            const events = [
              { type: "text-delta", text: "hi" },
              { type: "finish", finishReason: "stop" },
            ];
            let index = 0;
            return {
              next: async () =>
                index < events.length
                  ? { done: false, value: events[index++] }
                  : { done: true, value: undefined },
            };
          },
        },
        // The real toUIMessageStream invokes onFinish once the UI stream is
        // consumed; the route's Stop-hook round loop awaits that callback, so
        // the mock must fire it (with the thread grown by one assistant
        // message, like the SDK does).
        toUIMessageStream: (options?: {
          originalMessages?: unknown[];
          onFinish?: (args: { messages: unknown[] }) => Promise<void> | void;
        }) => {
          queueMicrotask(() => {
            void options?.onFinish?.({
              messages: [
                ...(options?.originalMessages ?? []),
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  parts: [{ type: "text", text: "hi" }],
                },
              ],
            });
          });
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
        usage: Promise.resolve(null),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({
          messages: [{ role: "assistant", content: "hi" }],
        }),
      }));
      mockCreateUIMessageStream.mockImplementation(
        ({
          execute,
        }: {
          execute: (args: {
            writer: {
              write: (x: unknown) => void;
              merge: (s: unknown) => void;
            };
          }) => Promise<void>;
        }) => {
          const writer = { write: vi.fn(), merge: vi.fn() };
          void execute({ writer }).catch(() => undefined);
          return {
            tee: () => [
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
            ],
          };
        },
      );
      mockCreateUIMessageStreamResponse.mockImplementation(
        ({ stream }: { stream: ReadableStream }) =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      );

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    (config.hooks as { enabled: boolean }).enabled = originalHooksEnabled;
    vi.restoreAllMocks();
    await app.close();
  });

  test("a proceeding lifecycle hook does not block the request", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
    });
    const createRunSpy = vi.spyOn(activeChatRunService, "createRun");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createRunSpy).toHaveBeenCalledTimes(1);
  });

  test("a thrown dispatcher error fails open (chat is never broken by hooks)", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockRejectedValue(
      new Error("dispatcher exploded"),
    );
    const createRunSpy = vi.spyOn(activeChatRunService, "createRun");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createRunSpy).toHaveBeenCalledTimes(1);
  });

  test("the Stop hook fires at end of turn and a proceed keeps a single round", async () => {
    const fireSpy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValue({ decision: "proceed", runs: [] });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(fireSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "stop",
          conversationId,
          fields: { stop_hook_active: false },
        }),
      );
    });
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  test("a blocking Stop hook feeds its reason back to the model and streams another round", async () => {
    const fireSpy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockImplementation(async ({ event, fields }) => {
        if (event === "stop" && fields.stop_hook_active === false) {
          return { decision: "block", reason: "write the tests too", runs: [] };
        }
        return { decision: "proceed", runs: [] };
      });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    // Second round: stop_hook_active flips to true so hooks can avoid loops.
    await vi.waitFor(() => {
      expect(fireSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "stop",
          fields: { stop_hook_active: true },
        }),
      );
    });
    expect(mockStreamText).toHaveBeenCalledTimes(2);

    // The continuation round sends the prior assistant output plus the hook's
    // stderr as a user message (Claude Code Stop semantics).
    const secondRoundMessages = mockStreamText.mock.calls[1][0].messages;
    expect(secondRoundMessages.at(-1)).toEqual({
      role: "user",
      content: "Stop hook feedback:\nwrite the tests too",
    });
    expect(secondRoundMessages.at(-2)).toEqual({
      role: "assistant",
      content: "hi",
    });
  });

  test("a Stop hook that keeps blocking stops at the continuation cap", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockImplementation(
      async ({ event }) =>
        event === "stop"
          ? { decision: "block", reason: "never enough", runs: [] }
          : { decision: "proceed", runs: [] },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    // 1 initial round + MAX_STOP_HOOK_CONTINUATIONS (5) continuation rounds.
    await vi.waitFor(() => {
      expect(mockStreamText).toHaveBeenCalledTimes(6);
    });
    // Give the final round a beat to confirm no further rounds start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockStreamText).toHaveBeenCalledTimes(6);
  });
});

describe("DELETE /api/chat/conversations/:id SessionEnd hook", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let agentId: string;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const agent = await makeAgent({
        organizationId,
        name: "Router Agent",
        systemPrompt: "",
      });
      agentId = agent.id;
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("fires session_end (reason: delete) before deleting the conversation", async () => {
    const fireSpy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValue({ decision: "proceed", runs: [] });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversationId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(fireSpy).toHaveBeenCalledWith({
      event: "session_end",
      conversationId,
      agentId,
      organizationId,
      userId: user.id,
      fields: { reason: "delete" },
    });

    const deleted = await ConversationModel.findById({
      id: conversationId,
      userId: user.id,
      organizationId,
    });
    expect(deleted).toBeNull();
  });

  test("a failing SessionEnd hook never prevents deletion", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockRejectedValue(
      new Error("dispatcher exploded"),
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversationId}`,
    });

    expect(response.statusCode).toBe(200);
    const deleted = await ConversationModel.findById({
      id: conversationId,
      userId: user.id,
      organizationId,
    });
    expect(deleted).toBeNull();
  });
});
