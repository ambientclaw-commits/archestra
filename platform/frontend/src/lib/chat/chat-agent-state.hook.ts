import type { archestraApiTypes } from "@archestra/shared";
import type { UIMessage } from "ai";
import { useMemo } from "react";

type ChatConversation = archestraApiTypes.GetChatConversationResponses["200"];
export type ChatAgentOption = { id: string; name: string };

export type ResolvedChatAgentState = {
  conversationAgentId: string | null;
  activeAgentId: string | null;
  promptAgentId: string | null;
};

export function resolveChatAgentState(params: {
  conversation: ChatConversation | null | undefined;
  initialAgentId: string | null;
  messages?: UIMessage[];
  agents?: ChatAgentOption[];
}): ResolvedChatAgentState {
  const { conversation, initialAgentId } = params;
  const conversationAgentId =
    conversation?.agentId ?? conversation?.agent?.id ?? null;
  const activeAgentId = conversationAgentId ?? initialAgentId;
  const promptAgentId = conversation?.agent?.id ?? activeAgentId;

  return {
    conversationAgentId,
    activeAgentId,
    promptAgentId,
  };
}

export function useChatAgentState(params: {
  conversation: ChatConversation | null | undefined;
  initialAgentId: string | null;
  messages?: UIMessage[];
  agents?: ChatAgentOption[];
}): ResolvedChatAgentState {
  const { conversation, initialAgentId, messages, agents } = params;

  return useMemo(
    () =>
      resolveChatAgentState({ conversation, initialAgentId, messages, agents }),
    [conversation, initialAgentId, messages, agents],
  );
}
