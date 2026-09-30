/**
 * batch.ts — 批次入口：预检、选择策略、等待结算，最后按模型源顺序构造消息。
 *
 * 这里接收已经由 Agent 规范化的配置，因此本模块只负责执行语义，
 * 不再猜测默认值或读取 Agent 的可变状态。
 */
import type {
	AfterToolCall,
	BeforeToolCall,
	EventSink,
	Tool,
	ToolCall,
	ToolExecutionMode,
	ToolResultMessage,
} from "../types.ts";
import { ToolEventDispatcher } from "./event-dispatcher.ts";
import type { CompletedToolCall } from "./execute-call.ts";
import { prepareToolCalls } from "./prepare.ts";
import {
	executeParallel,
	executeSequential,
	shouldExecuteInParallel,
} from "./scheduler.ts";
import { SerialQueue } from "./serial-queue.ts";

/**
 * 执行一个 Tool Call 批次所需的运行时依赖。
 */
export interface ToolExecutionBatchOptions {
	tools: readonly Tool<unknown>[];
	toolExecutionMode: ToolExecutionMode;
	maxConcurrency: number;
	beforeToolCall?: BeforeToolCall;
	afterToolCall?: AfterToolCall;
	emit: EventSink;
	signal: AbortSignal;
}

export interface ToolExecutionBatch {
	messages: ToolResultMessage[];
}

export type MarkStarted = (toolCall: ToolCall) => void;
export type MarkTerminal = (toolCallId: string) => void;

/** 将内部完成记录转换成下一轮模型可见的 Tool Result Message。 */
function toMessage(completed: CompletedToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: completed.toolCall.id,
		toolName: completed.toolCall.name,
		content: completed.result.content,
		details: completed.result.details,
		isError: completed.result.isError === true,
		timestamp: Date.now(),
	};
}

/**
 * 为已经 start、但尚未 end 的调用补发取消终止事件。
 * EventSink 自身失败时无法可靠通知外部消费者，只能由 Agent finally
 * 清理内部 pending 状态，所以这里直接停止继续分发。
 */
async function emitCancelledForOpenCalls(
	started: ReadonlyMap<string, ToolCall>,
	terminal: ReadonlySet<string>,
	reason: "aborted" | "control_error",
	events: ToolEventDispatcher,
): Promise<void> {
	if (events.failed) return;
	for (const toolCall of started.values()) {
		if (terminal.has(toolCall.id)) continue;
		await events.emit({
			type: "tool_execution_cancelled",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			reason,
		});
	}
}

/**
 * 批次入口：预检、选择策略、等待结算，最后按模型源顺序构造消息。
 * 在本函数成功返回前不会修改 Transcript，因此失败批次不会部分提交结果。
 */
export async function executeToolCallBatch(
	toolCalls: readonly ToolCall[],
	options: ToolExecutionBatchOptions,
): Promise<ToolExecutionBatch> {
	if (toolCalls.length === 0) return { messages: [] };

	// 第 1 步：预检。按模型源顺序把每个调用分成 ready（待真实执行）和
	// immediate（直接合成错误结果）。此阶段不产生任何工具副作用，
	// 因此 beforeToolCall 看到的是完整的、尚未被执行过的批次。
	const prepared = await prepareToolCalls(toolCalls, options);

	// 第 2 步：搭建本批次的运行时通道。
	// events 让多个并行工具共享同一个串行事件出口；
	// finalization 保证 afterToolCall 与 end 事件逐个执行。
	const events = new ToolEventDispatcher(options.emit);
	const finalization = new SerialQueue();
	// started / terminal 是生命周期簿记：谁发过 start、谁已发 end。
	// 批次失败时靠两者的差集找出"开了头没收尾"的调用。
	const started = new Map<string, ToolCall>();
	const terminal = new Set<string>();
	const markStarted = (toolCall: ToolCall): void => {
		started.set(toolCall.id, toolCall);
	};
	const markTerminal = (toolCallId: string): void => {
		terminal.add(toolCallId);
	};

	// 第 3 步：选择调度策略并执行。并行是显式 opt-in——任何一个 ready
	// 工具没声明 parallel，整个批次都降级为串行兼容模式。
	let completed: CompletedToolCall[];
	try {
		completed = shouldExecuteInParallel(prepared, options.toolExecutionMode)
			? await executeParallel(
					prepared,
					options,
					events,
					finalization,
					markStarted,
					markTerminal,
				)
			: await executeSequential(
					prepared,
					options,
					events,
					finalization,
					markStarted,
					markTerminal,
				);
	} catch (error) {
		// 批次失败（取消或控制面错误）：给“已 start 未 end”的调用补发
		// cancelled 事件，让外部消费者看到的生命周期完整闭合。
		const reason = options.signal.aborted ? "aborted" : "control_error";
		try {
			await emitCancelledForOpenCalls(started, terminal, reason, events);
		} catch {
			// Preserve the original control error or abort reason.
		}
		// 取消语义优先于错误语义：用户按了停止，就报取消而不是报错误。
		if (options.signal.aborted) options.signal.throwIfAborted();
		throw error;
	}

	// 第 4 步：按 index 恢复模型源顺序（并行会打乱完成顺序），
	// 再把内部完成记录转成下一轮模型可见的 ToolResultMessage。
	completed.sort((left, right) => left.index - right.index);
	return { messages: completed.map(toMessage) };
}
