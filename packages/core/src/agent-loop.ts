import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  CompletedTurn,
  EventSink,
  ToolCall,
  ToolExecutionResult,
  ToolResultMessage,
} from "./types.ts";

function cloneAssistant(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((content) => ({ ...content })),
  };
}

async function emitMessage(message: AgentMessage, emit: EventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  let finalMessage: AssistantMessage | undefined;

  for await (const modelEvent of config.stream(context.messages, signal)) {
    finalMessage = modelEvent.message;

    if (modelEvent.type === "start") {
      await emit({
        type: "message_start",
        message: cloneAssistant(modelEvent.message),
      });
      continue;
    }

    if (
      modelEvent.type === "text_delta" ||
      modelEvent.type === "tool_call"
    ) {
      await emit({
        type: "message_update",
        message: cloneAssistant(modelEvent.message),
        modelEvent,
      });
      continue;
    }

    await emit({ type: "message_end", message: modelEvent.message });
  }

  if (!finalMessage) {
    throw new Error("Model stream ended without an Assistant message");
  }

  context.messages.push(finalMessage);
  return finalMessage;
}

function errorResult(content: string): ToolExecutionResult {
  return { content, isError: true };
}

async function executeToolCall(
  context: AgentContext,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<ToolResultMessage> {
  await emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    argumentsValue: toolCall.arguments,
  });

  const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
  let result: ToolExecutionResult;

  if (!tool) {
    result = errorResult(`Unknown tool: ${toolCall.name}`);
  } else {
    const validation = tool.validate(toolCall.arguments);
    if (!validation.ok) {
      result = errorResult(validation.error);
    } else {
      const blocked = await config.beforeToolCall?.(
        toolCall,
        validation.value,
        signal,
      );

      if (blocked) {
        result = errorResult(blocked.reason);
      } else {
        try {
          result = await tool.execute(
            toolCall.id,
            validation.value,
            signal,
            async (partial) => {
              await emit({
                type: "tool_execution_update",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                partial,
              });
            },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          result = errorResult(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  const replacement = await config.afterToolCall?.(toolCall, result, signal);
  const finalResult = replacement ?? result;
  const isError = finalResult.isError === true;

  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: finalResult,
    isError,
  });

  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: finalResult.content,
    details: finalResult.details,
    isError,
    timestamp: Date.now(),
  };
  await emitMessage(message, emit);
  context.messages.push(message);
  return message;
}

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  for (const prompt of prompts) {
    await emitMessage(prompt, emit);
    context.messages.push(prompt);
  }

  let pendingMessages = config.getSteeringMessages();
  let completedTurn: CompletedTurn | undefined;
  let explicitContinuation = false;
  let firstTurn = true;

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) await emit({ type: "turn_start" });
      firstTurn = false;

      for (const message of pendingMessages) {
        await emitMessage(message, emit);
        context.messages.push(message);
      }
      pendingMessages = [];

      const assistant = await streamAssistantResponse(
        context,
        config,
        emit,
        signal,
      );
      const toolCalls = assistant.content.filter(
        (content): content is ToolCall => content.type === "toolCall",
      );
      const toolResults: ToolResultMessage[] = [];

      for (const toolCall of toolCalls) {
        toolResults.push(
          await executeToolCall(context, toolCall, config, emit, signal),
        );
      }

      completedTurn = {
        message: assistant,
        toolResults,
        context,
      };
      const decision = await config.finishTurn?.(completedTurn, signal);
      await emit({ type: "turn_end", message: assistant, toolResults });

      if (decision?.action === "end") {
        await emit({ type: "agent_end", messages: context.messages.slice() });
        return;
      }

      explicitContinuation = decision?.action === "continue";
      hasMoreToolCalls = toolResults.length > 0;
      pendingMessages = config.getSteeringMessages();
      if (hasMoreToolCalls || pendingMessages.length > 0) {
        explicitContinuation = false;
      }
    }

    const followUps = config.getFollowUpMessages();
    if (followUps.length > 0) {
      pendingMessages = followUps;
      explicitContinuation = false;
      continue;
    }

    if (explicitContinuation) {
      explicitContinuation = false;
      continue;
    }

    break;
  }

  void completedTurn;
  await emit({ type: "agent_end", messages: context.messages.slice() });
}
