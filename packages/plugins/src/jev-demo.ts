// jev-demo.ts — 用 ai-sdk 接入 DeepSeek 的 System One 风格结构化判断
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateObject } from "ai";
import { z } from "zod";

const deepseek = createDeepSeek({
	apiKey: process.env.DEEPSEEK_API_KEY,
	baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
});

// ---------- 问题定义（格式贴近 Jev 的 Choice / Score / Noul） ----------

interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

interface NoulQuestion {
	type: "noul";
	instructions: string;
}

type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

// ---------- 把 questions 编译成 zod schema，交给 generateObject 强制约束输出 ----------

function buildAnswerSchema(questions: Record<string, Question>) {
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, q] of Object.entries(questions)) {
		if (q.type === "choice") {
			const options = Object.keys(q.criteria);
			if (options.length === 0)
				throw new Error(`choice 问题 "${key}" 至少需要一个选项`);
			shape[key] = z
				.object({
					choice: z.enum(options as [string, ...string[]]).describe(
						Object.entries(q.criteria)
							.map(([k, v]) => `${k}: ${v}`)
							.join("；"),
					),
					confidence: z.number().min(0).max(1),
					probabilities: z.object(
						Object.fromEntries(
							options.map((k) => [k, z.number().min(0).max(1)]),
						),
					),
				})
				.describe(q.instructions);
		} else if (q.type === "score") {
			const max = Math.max(q.criteria.length - 1, 0);
			shape[key] = z
				.object({
					score: z
						.number()
						.int()
						.min(0)
						.max(max)
						.describe(
							`0-${max} 的整数，分别对应：${q.criteria
								.map((c, i) => `${i}=${c}`)
								.join("，")}`,
						),
					confidence: z.number().min(0).max(1),
				})
				.describe(q.instructions);
		} else {
			shape[key] = z
				.object({
					noul: z.number().min(0).max(1).describe("0~1 的概率"),
				})
				.describe(q.instructions);
		}
	}

	return z.object(shape);
}

/**
 * 通用 System One 风格调用
 * @param state 要判断的内容（字符串或任意可序列化对象）
 * @param questions 问题定义，见上方类型
 */
async function systemOne(
	state: unknown,
	questions: Record<string, Question>,
	options: { model?: string; temperature?: number } = {},
) {
	const schema = buildAnswerSchema(questions);

	const { object, usage } = await generateObject({
		model: deepseek.chat(options.model ?? "deepseek-flash"),
		schema,
		system:
			"你是一个严格的决策引擎。根据用户给出的状态，逐一回答 schema 中定义的每个问题：" +
			"choice 从给定选项中选；score 是 criteria 数组的下标；noul 是 0~1 的概率；confidence 是你对答案的把握。",
		prompt: `请根据以下状态做出决策：\n\n${
			typeof state === "string" ? state : JSON.stringify(state, null, 2)
		}`,
		temperature: options.temperature ?? 0.1,
		maxOutputTokens: 800,
		providerOptions: {
			deepseek: { thinking: { type: "disabled" } },
		},
	});

	return { answers: object, usage };
}

// ==================== 使用示例 ====================

async function demo() {
	const start = performance.now();
	const result = await systemOne(
		"客户：我被扣了两次款，已经三天没人回复了，气死了！赶紧退钱！",
		{
			department: {
				type: "choice",
				instructions: "这条消息应该分配给哪个团队",
				criteria: {
					billing: "退款、重复扣款、支付问题",
					technical: "系统故障、接口问题",
					account: "账号权限问题",
					other: "其他",
				},
			},
			urgency: {
				type: "score",
				instructions: "紧急程度",
				criteria: [
					"可以慢慢处理",
					"今天处理较好",
					"比较紧急",
					"非常紧急可能流失",
				],
			},
			escalate: {
				type: "noul",
				instructions: "是否需要立刻转人工",
			},
		},
		{
			temperature: 0,
		},
	);

	const elapsedMs = Math.round(performance.now() - start);
	console.log(JSON.stringify(result, null, 2));
	console.log(`\n总耗时: ${elapsedMs} ms (${(elapsedMs / 1000).toFixed(2)} s)`);
}

demo().catch(console.error);
