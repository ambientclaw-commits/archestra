/**
 * GitHub Copilot LLM Proxy Adapter - OpenAI-compatible
 *
 * Copilot serves an OpenAI-compatible chat completions API, so all
 * request/response/stream adapter logic delegates to OpenAI (same pattern as
 * DeepSeek). The provider-specific part is auth: the incoming "API key" is a
 * long-lived GitHub OAuth token (`gho_…`), which every outgoing request must
 * swap for a short-lived Copilot bearer (see services/github-copilot-token).
 * The swap happens in a fetch wrapper because `createClient` is synchronous.
 */
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { metrics } from "@/observability";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import type {
  CreateClientOptions,
  GithubCopilot,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
} from "@/types";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// TYPE ALIASES (reuse OpenAI-compatible GitHub Copilot types)

type GithubCopilotRequest = GithubCopilot.Types.ChatCompletionsRequest;
type GithubCopilotResponse = GithubCopilot.Types.ChatCompletionsResponse;
type GithubCopilotMessages =
  GithubCopilot.Types.ChatCompletionsRequest["messages"];
type GithubCopilotHeaders = GithubCopilot.Types.ChatCompletionsHeaders;
type GithubCopilotStreamChunk = GithubCopilot.Types.ChatCompletionChunk;

// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)

/**
 * GitHub Copilot request adapter - wraps OpenAI adapter with Copilot provider name.
 */
class GithubCopilotRequestAdapter
  implements LLMRequestAdapter<GithubCopilotRequest, GithubCopilotMessages>
{
  readonly provider = "github-copilot" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: GithubCopilotRequest) {
    this.delegate = new OpenAIRequestAdapter(request);
  }

  getModel() {
    return this.delegate.getModel();
  }
  isStreaming() {
    return this.delegate.isStreaming();
  }
  getMessages() {
    return this.delegate.getMessages();
  }
  getToolResults() {
    return this.delegate.getToolResults();
  }
  getTools() {
    return this.delegate.getTools();
  }
  hasTools() {
    return this.delegate.hasTools();
  }
  getProviderMessages() {
    return this.delegate.getProviderMessages();
  }
  getOriginalRequest() {
    return this.delegate.getOriginalRequest();
  }
  setModel(model: string) {
    return this.delegate.setModel(model);
  }
  updateToolResult(toolCallId: string, newContent: string) {
    return this.delegate.updateToolResult(toolCallId, newContent);
  }
  applyToolResultUpdates(updates: Record<string, string>) {
    return this.delegate.applyToolResultUpdates(updates);
  }
  applyToonCompression(model: string) {
    return this.delegate.applyToonCompression(model);
  }
  convertToolResultContent(messages: GithubCopilotMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

/**
 * GitHub Copilot response adapter - wraps OpenAI adapter with Copilot provider name.
 */
class GithubCopilotResponseAdapter
  implements LLMResponseAdapter<GithubCopilotResponse>
{
  readonly provider = "github-copilot" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: GithubCopilotResponse) {
    this.delegate = new OpenAIResponseAdapter(response);
  }

  getId() {
    return this.delegate.getId();
  }
  getModel() {
    return this.delegate.getModel();
  }
  getText() {
    return this.delegate.getText();
  }
  getToolCalls() {
    return this.delegate.getToolCalls();
  }
  hasToolCalls() {
    return this.delegate.hasToolCalls();
  }
  getUsage() {
    return this.delegate.getUsage();
  }
  getFinishReasons() {
    return this.delegate.getFinishReasons();
  }
  getOriginalResponse() {
    return this.delegate.getOriginalResponse();
  }
  toRefusalResponse(refusalMessage: string, contentMessage: string) {
    return this.delegate.toRefusalResponse(refusalMessage, contentMessage);
  }
}

/**
 * GitHub Copilot stream adapter - wraps OpenAI adapter with Copilot provider name.
 */
class GithubCopilotStreamAdapter
  implements LLMStreamAdapter<GithubCopilotStreamChunk, GithubCopilotResponse>
{
  readonly provider = "github-copilot" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: GithubCopilotStreamChunk) {
    return this.delegate.processChunk(chunk);
  }
  getSSEHeaders() {
    return this.delegate.getSSEHeaders();
  }
  formatTextDeltaSSE(text: string) {
    return this.delegate.formatTextDeltaSSE(text);
  }
  getRawToolCallEvents() {
    return this.delegate.getRawToolCallEvents();
  }
  formatCompleteTextSSE(text: string) {
    return this.delegate.formatCompleteTextSSE(text);
  }
  formatEndSSE() {
    return this.delegate.formatEndSSE();
  }
  toProviderResponse() {
    return this.delegate.toProviderResponse();
  }
}

// ADAPTER FACTORY

export const githubCopilotAdapterFactory: LLMProvider<
  GithubCopilotRequest,
  GithubCopilotResponse,
  GithubCopilotMessages,
  GithubCopilotStreamChunk,
  GithubCopilotHeaders
> = {
  provider: "github-copilot",
  interactionType: "github-copilot:chatCompletions",

  createRequestAdapter(
    request: GithubCopilotRequest,
  ): LLMRequestAdapter<GithubCopilotRequest, GithubCopilotMessages> {
    return new GithubCopilotRequestAdapter(request);
  },

  createResponseAdapter(
    response: GithubCopilotResponse,
  ): LLMResponseAdapter<GithubCopilotResponse> {
    return new GithubCopilotResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<
    GithubCopilotStreamChunk,
    GithubCopilotResponse
  > {
    return new GithubCopilotStreamAdapter();
  },

  extractApiKey(headers: GithubCopilotHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm["github-copilot"].baseUrl;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const observableFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "github-copilot",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      // Placeholder satisfies the SDK; the wrapper sets the real bearer.
      apiKey: apiKey ?? "github-copilot",
      baseURL: options.baseUrl ?? config.llm["github-copilot"].baseUrl,
      fetch: createGithubCopilotFetch({
        githubToken: apiKey,
        innerFetch: observableFetch,
      }),
      defaultHeaders: options.defaultHeaders,
    });
  },

  async execute(
    client: unknown,
    request: GithubCopilotRequest,
  ): Promise<GithubCopilotResponse> {
    const copilotClient = client as OpenAIProvider;
    const copilotRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return copilotClient.chat.completions.create(
      copilotRequest,
    ) as unknown as Promise<GithubCopilotResponse>;
  },

  async executeStream(
    client: unknown,
    request: GithubCopilotRequest,
  ): Promise<AsyncIterable<GithubCopilotStreamChunk>> {
    const copilotClient = client as OpenAIProvider;
    const copilotRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await copilotClient.chat.completions.create(copilotRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as GithubCopilotStreamChunk;
        }
      },
    };
  },

  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    if (get(error, "error.code") === "context_length_exceeded") {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    const openaiMessage = get(error, "error.message");
    if (typeof openaiMessage === "string") {
      return openaiMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
