# 阶段 8：结构化输出

## 当前问题

当前 Assistant 最终结果是自由文本：

```text
项目名称是 mock-agent-demo。
```

如果上层程序需要：

```ts
{
  projectName: "mock-agent-demo",
  version: "1.0.0"
}
```

仅靠解析自然语言不可靠。真实系统需要让模型输出符合契约的数据，并在使用前验证。

本阶段解决“**怎样把模型结果转换成经过验证的程序数据**”。

## 学习目标

- 区分文本回答和结构化结果。
- 设计与 Provider 无关的 `OutputContract<T>`。
- 支持原生 JSON Schema 与 Tool Fallback。
- 对验证失败进行有限修复，而不是强制类型断言。

## 非目标

- 不构建完整 Schema 库。
- 不允许 `JSON.parse()` 后直接 `as T`。
- 不让结构化输出替代普通 Tool Calling。
- 不把业务验证全部交给模型。

## 方案比较

### 方案 A：Prompt 要求“只输出 JSON”

简单但模型可能添加 Markdown、漏字段或输出错误类型。

### 方案 B：将结果作为特殊工具 `submit_result`

兼容支持 Tool Calling 的模型，参数天然是结构化对象；但语义上它不是外部副作用工具。

### 方案 C：统一 Output Contract，Provider 原生优先、Tool Fallback，推荐

Runtime 只依赖验证契约，Adapter 决定如何约束模型。

## OutputContract

```ts
export interface OutputContract<T> {
  name: string;
  description: string;
  schema: JsonSchema;
  validate(value: unknown): ValidationResult<T>;
}
```

使用时：

```ts
await agent.prompt("读取 package.json 并返回项目信息", {
  output: projectInfoContract,
});
```

结果：

```ts
interface AgentRunResult<T = undefined> {
  messages: AgentMessage[];
  output: T;
}
```

无结构化契约时 `output` 为 `undefined`。

## 两种生成模式

### Provider 原生模式

如果模型支持 JSON Schema：

```text
OutputContract.schema
→ Provider response_format
→ JSON value
→ 本地 validate
```

### Tool Fallback

如果模型只支持工具：

```text
临时注册 submit_result
→ 参数 Schema = OutputContract.schema
→ 模型调用 submit_result(args)
→ Runtime 截获，不进入普通工具执行器
→ 本地 validate(args)
```

`submit_result` 是控制协议，不执行外部副作用。

## 类型设计

增加：

```ts
export interface StructuredOutputMessage {
  role: "structuredOutput";
  contract: string;
  value: unknown;
  valid: boolean;
  validationError?: string;
  timestamp: number;
}
```

是否将其写入模型上下文要谨慎。推荐：

- 写入 Session，供恢复和 UI 展示。
- 默认不直接发送给后续模型。
- 如果需要继续讨论结果，由 `transformContext` 转换成标准 User/System 内容。

## 验证失败

第一版允许最多一次修复 Turn：

```text
模型给出 value
    ↓
validate 失败
    ↓
插入明确错误：
"字段 version 必须是字符串"
    ↓
模型重新提交一次
    ↓
仍失败 → Run error
```

必须有限次，避免无限修复循环。

验证错误应具体、确定且不包含内部堆栈。

## 业务验证

Schema 验证只能确认形状：

```text
version 是 string
```

业务验证还要确认：

```text
version 符合 semver
项目名称来自实际 Tool Result
金额非负且币种允许
```

`validate()` 可以执行同步业务规则，但不要产生外部副作用。

## 与 Tool Calling 的关系

一次任务可以先调用普通工具，再提交结构化结果：

```text
read(package.json)
→ Tool Result
→ submit_result({
     projectName,
     version
   })
```

普通工具回答“获取信息”，Output Contract 回答“最终结果以什么形状交付”。

## Provider 能力

阶段 7 的 `ModelDefinition` 增加：

```ts
supportsStructuredOutput: boolean;
```

选择策略：

```text
支持原生 Schema → 原生模式
否则支持工具 → submit_result fallback
两者都不支持 → 拒绝结构化请求
```

## Server 和 Web

Server 协议可以增加：

```ts
type ServerMessage =
  | { type: "runResult"; output: unknown; contract: string };
```

Web UI 同时展示：

- 人类可读 Assistant 文本
- 已验证的结构化 JSON
- 验证错误和修复次数

不要让客户端提供任意可执行 Validator。Contract 必须由 Server 预注册。

## 测试策略

1. 合法对象通过验证并返回强类型结果。
2. 缺字段、错误类型和额外限制产生具体错误。
3. `JSON.parse()` 成功但业务验证失败。
4. Provider 原生模式和 Tool Fallback 通过相同契约测试。
5. 第一次失败、第二次修复成功。
6. 两次失败后明确终止，不无限循环。
7. 不支持结构化输出的模型被拒绝。
8. 恢复 Session 后可以读取已经验证的结果。

## 验收标准

- 上层代码不需要解析自然语言。
- 不出现未经验证的 `as T`。
- 验证失败可观察且次数有限。
- 结构化输出不绕过普通工具安全策略。

## 学习练习

1. 创建 `ProjectInfo` Contract。
2. 让 Mock LLM 第一次漏掉 `version`，第二次修正。
3. 实现原生模式和 `submit_result` 模式的共同测试。
4. 添加业务规则：版本必须是合法 semver。

## 进入下一阶段前

你应该能够回答：

- 为什么“只输出 JSON”不等于结构化输出？
- `submit_result` 为什么不是普通副作用工具？
- Schema 验证和业务验证有什么区别？

