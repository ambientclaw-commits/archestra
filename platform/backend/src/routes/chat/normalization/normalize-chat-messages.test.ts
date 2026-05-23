import { describe, expect, test } from "vitest";
import {
  normalizeChatMessages,
  normalizeChatMessagesForStorage,
} from "./normalize-chat-messages";

describe("normalizeChatMessages", () => {
  test("dedupes duplicate tool parts with the same toolCallId", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Creating the agent now." },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created",
          },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created",
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "call_swap_1",
            state: "output-available",
            output: "swapped",
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "call_swap_1",
            state: "output-available",
            output: "swapped",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);
    const dedupedParts = result[0].parts ?? [];

    expect(dedupedParts).toHaveLength(3);
    expect(
      dedupedParts.filter((part) => part.toolCallId === "call_create_1"),
    ).toHaveLength(1);
    expect(
      dedupedParts.filter((part) => part.toolCallId === "call_swap_1"),
    ).toHaveLength(1);
  });

  test("drops a dangling input-streaming tool call (stopped mid-stream)", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Looking that up." },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_interrupted",
            state: "input-streaming",
            input: { name: "Ag" },
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toEqual([
      { type: "text", text: "Looking that up." },
    ]);
  });

  test("preserves distinct tool parts when toolCallIds differ", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created-1",
          },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_2",
            state: "output-available",
            output: "created-2",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toHaveLength(2);
  });

  test("replaces data URL file parts when normalizing messages for storage", () => {
    const messages = [
      {
        id: "msg1",
        role: "user" as const,
        parts: [
          { type: "text", text: "Please inspect this file." },
          {
            type: "file",
            url: "data:application/pdf;base64,abc123",
            mediaType: "application/pdf",
            filename: "test.pdf",
          },
        ],
      },
    ];

    const result = normalizeChatMessagesForStorage(messages);

    expect(result[0].parts).toEqual([
      { type: "text", text: "Please inspect this file." },
      {
        type: "text",
        text: "[File attachment omitted from stored chat history]",
      },
    ]);
  });

  test("preserves data URL file parts when normalizing messages for the model", () => {
    const messages = [
      {
        id: "msg1",
        role: "user" as const,
        parts: [
          {
            type: "file",
            url: "data:application/pdf;base64,abc123",
            mediaType: "application/pdf",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toEqual(messages[0].parts);
  });
});
