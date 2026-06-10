"use client";

import { Route } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateConversation } from "@/lib/chat/chat.query";
import { useFeature } from "@/lib/config/config.query";
import { useLlmRouters } from "@/lib/llm-router.query";

const NONE_VALUE = "__none__";

/**
 * Lets the user route a conversation through a smart router. Selecting one
 * pins the router's premium model as the conversation's baseline; the proxy
 * then routes each message down to the everyday model when it's good enough.
 */
export function SmartRouterSelector({
  conversationId,
  currentLlmRouterId,
}: {
  conversationId?: string;
  currentLlmRouterId?: string | null;
}) {
  const smartRouterEnabled = useFeature("smartRouterEnabled");
  const { data: routers = [] } = useLlmRouters();
  const updateConversation = useUpdateConversation();

  const activeRouters = routers.filter((router) => router.enabled);

  if (
    smartRouterEnabled === false ||
    !conversationId ||
    activeRouters.length === 0
  ) {
    return null;
  }

  const handleChange = (value: string) => {
    if (value === NONE_VALUE) {
      updateConversation.mutate({ id: conversationId, llmRouterId: null });
      return;
    }
    const router = activeRouters.find((candidate) => candidate.id === value);
    if (!router) return;
    updateConversation.mutate({
      id: conversationId,
      llmRouterId: router.id,
      modelId: router.premiumModelId ?? undefined,
      chatApiKeyId: router.premiumApiKeyId ?? undefined,
    });
  };

  return (
    <Select
      value={currentLlmRouterId ?? NONE_VALUE}
      onValueChange={handleChange}
    >
      <SelectTrigger
        className="h-8 w-auto gap-1.5 text-xs"
        aria-label="Smart router"
      >
        <Route className="h-3.5 w-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>No smart router</SelectItem>
        {activeRouters.map((router) => (
          <SelectItem key={router.id} value={router.id}>
            {router.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
