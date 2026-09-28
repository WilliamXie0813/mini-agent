# 阶段 13：Skills 系统

## 当前基线与问题

Agent 可以通过 System Prompt 获得规则，但把所有领域知识一次性放入 Prompt 会产生：

- Token 成本持续增加。
- 无关说明干扰当前任务。
- 更新某个工作流程必须修改主 System Prompt。
- 不同项目很难组合自己的工作方法。
- 模型不知道有哪些可选能力可以按需读取。

例如 Agent 同时拥有：

```text
发布流程
数据库迁移
代码审查
PDF 处理
前端设计
故障诊断
```

当前任务只需要“代码审查”，没有必要加载其他五份完整说明。

本阶段解决“**怎样先向模型展示 Skill 索引，再在需要时加载完整 Skill 内容**”。

## 学习目标

- 区分 Skill、Tool、Extension 和 System Prompt。
- 定义可发现、可验证、可追踪来源的 Skill 文件格式。
- 实现 Metadata Eager、Content Lazy 的渐进加载。
- 支持用户显式调用和模型建议调用。
- 处理命名冲突、忽略规则、重新加载和内容安全。

## 非目标

- 不执行 Skill 文件中的代码。
- 不让 Skill 绕过 Tool 权限。
- 不做语义向量搜索。
- 不从互联网自动安装 Skill。
- 不默认把所有 Skill 正文塞入 System Prompt。

## 四种概念的区别

| 概念 | 本质 | 谁触发 | 能否执行副作用 |
|---|---|---|---|
| System Prompt | 全局基础规则 | Runtime | 否 |
| Skill | 按需加载的指导文本 | 用户或模型选择 | 否 |
| Tool | 可执行能力 | 模型 Tool Call | 可以 |
| Extension | 本地可执行扩展代码 | Host 生命周期 | 可以 |

Skill 可以告诉模型“怎样使用 Tool”，但不能自己执行 Tool。

## Pi 中值得学习的设计

Pi 的 Skill Loader：

- 递归发现 `SKILL.md`。
- 支持 Markdown Frontmatter。
- 验证名称、描述和长度。
- 遵守 `.gitignore`、`.ignore`、`.fdignore`。
- 对读取、解析和元数据问题返回 Diagnostic。
- 保留 Skill 文件来源。
- 将 Skill 调用格式化为带位置的 `<skill>` Block。
- 支持 `disable-model-invocation`。

教学版可以先实现 `.gitignore` 的有限子集，或只支持 `.skillignore`，但接口应保留诊断和来源。

## Skill 文件格式

推荐目录：

```text
skills/
└── code-review/
    ├── SKILL.md
    ├── checklist.md
    └── examples/
        └── finding.md
```

`SKILL.md`：

```markdown
---
name: code-review
description: Review code changes for correctness and high-confidence bugs.
disable-model-invocation: false
---

# Code Review

1. Inspect the complete diff.
2. Trace changed behavior.
3. Report only actionable findings.
```

引用文件相对于 Skill 目录解析。

## 数据模型

```ts
export interface SkillMetadata {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export interface SkillSource {
  kind: "builtin" | "user" | "project" | "extension";
  path: string;
  priority: number;
}

export interface Skill {
  metadata: SkillMetadata;
  source: SkillSource;
  baseDirectory: string;
  filePath: string;
}

export interface LoadedSkill extends Skill {
  content: string;
}
```

发现阶段只创建 `Skill`，调用阶段才创建 `LoadedSkill`。

## 名称和描述验证

推荐约束：

```text
name:
- 1 到 64 字符
- 只允许小写字母、数字和连字符
- 不能以连字符开头或结尾
- 不能包含连续两个连字符
- 必须与父目录名一致

description:
- 必填
- 1 到 1024 字符
- 必须说明何时应该使用
```

Metadata 无效时：

- 不加载该 Skill。
- 返回稳定 Diagnostic Code。
- 继续加载其他 Skill。

## Diagnostic

```ts
export type SkillDiagnosticCode =
  | "read_failed"
  | "parse_failed"
  | "invalid_name"
  | "invalid_description"
  | "duplicate_name"
  | "outside_root";

export interface SkillDiagnostic {
  severity: "warning" | "error";
  code: SkillDiagnosticCode;
  message: string;
  path: string;
}
```

不要因为一个损坏 Skill 让整个 Agent 无法启动。

## 发现与加载

```ts
export interface SkillRegistry {
  discover(
    inputs: readonly SkillDiscoveryInput[],
  ): Promise<SkillDiscoveryResult>;

  list(): readonly Skill[];

  load(name: string): Promise<LoadedSkill>;

  reload(): Promise<SkillDiscoveryResult>;
}
```

```ts
export interface SkillDiscoveryInput {
  directory: string;
  source: SkillSource["kind"];
  priority: number;
}
```

发现流程：

```text
遍历配置目录
    ↓
应用 Ignore Rules
    ↓
寻找 SKILL.md
    ↓
读取 Frontmatter
    ↓
验证 Metadata
    ↓
建立轻量索引
```

正文可以在发现阶段读取一次用于分离 Frontmatter，但 Registry 不把所有正文放进 System Prompt。

## 来源和冲突

建议优先级：

```text
project > user > builtin
```

Extension Skill 是否允许覆盖，需要显式配置；默认不覆盖同名 Project Skill。

发生重名时不要静默选择：

```text
选择优先级更高的 Skill
+ 产生 duplicate_name Warning
+ 保留所有来源供诊断页展示
```

这样行为确定，同时用户知道某个 Skill 被遮蔽。

## 渐进式上下文加载

### 第一步：System Prompt 只放索引

```text
Available skills:
- code-review: Review code changes for correctness...
- release: Prepare and verify a package release...
- diagnose: Diagnose hard bugs using a disciplined loop...
```

### 第二步：按需加载正文

用户显式调用：

```text
/skill:code-review 请检查这次修改
```

展开为：

```xml
<skill name="code-review" location="/project/skills/code-review/SKILL.md">
References are relative to /project/skills/code-review.

[Skill body]
</skill>

请检查这次修改
```

## 用户调用与模型调用

### 用户显式调用

始终允许，只要 Skill 存在且通过验证。

### 模型建议调用

当 `disableModelInvocation` 为 `false` 时，可以在 System Prompt 中告诉模型：

```text
When a listed skill clearly matches the task, request its content.
```

教学版有两种实现选择：

#### 选择 A：特殊 Tool `load_skill`

```ts
load_skill({ name: "code-review" })
```

Runtime 返回 Skill 正文作为 Tool Result。

#### 选择 B：Runtime 在 Prompt 前自行匹配

容易误匹配，而且把路由逻辑写死在 Runtime。

推荐选择 A，因为调用是显式、可观察、可测试的。

`load_skill` 只读取已索引 Skill，不允许传任意文件路径。

## Skill 内容与 Transcript

用户显式调用后，展开的 Skill Block 可以作为 User Message 持久化，使恢复结果确定。

模型调用 `load_skill` 时：

```text
Tool Call
→ Tool Result 包含 Skill 内容
→ 正常写入 Transcript
```

这会增加上下文，所以阶段 10 的 Compaction Summary 应记录：

- 使用了哪些 Skill。
- 当前仍需遵守的关键工作流程。
- 不必完整复制全部 Skill 正文。

## 引用资源

Skill 可能引用：

```text
checklist.md
examples/example.md
templates/report.txt
```

Skill 内容应该告诉模型相对路径基准。

模型仍通过普通 `read` Tool 读取引用资源，因此：

- 继续受 Tool Allowlist 限制。
- 继续受路径和 Sandbox 策略限制。
- Skill Loader 不直接把整个目录注入 Context。

## Ignore Rules

最低要求：

- 跳过隐藏目录。
- 跳过 `node_modules`。
- 不跟随越过 Root 的符号链接。
- 支持明确 Ignore 文件。

如果支持 `.gitignore` 语义，应复用成熟库；不要手写一个不完整却声称兼容的 Parser。

第一版也可以定义自己的 `.skillignore`，但必须在文档中明确它不是 `.gitignore`。

## Reload

```text
Extension 或用户请求 Reload
      ↓
重新发现 Skill
      ↓
创建新 Registry Snapshot
      ↓
验证并产生 Diagnostics
      ↓
原子替换索引
```

正在执行的 Turn 使用旧 Snapshot，下一 Turn 使用新 Snapshot。

已经进入 Transcript 的 Skill 内容不会因 Reload 被修改。

## 安全边界

Skill 是不可信指令文本，可能包含：

```text
忽略系统规则
读取密钥
执行危险命令
```

因此：

- Skill 优先级低于 System Prompt 和 Runtime Policy。
- Skill 不能修改 Tool Allowlist。
- `disable-model-invocation` 可以阻止模型自行加载敏感流程。
- 项目 Skill 在阶段 14 的 Project Trust 通过前不自动启用。
- Server 客户端不能提交任意 Skill 路径。

## 对各包的影响

### `packages/core`

- 定义 `Skill`、`SkillRegistry` 和 `load_skill` Tool 契约。
- Agent Loop 不负责目录扫描。
- Context Pipeline 负责加入 Skill Metadata 索引。

### `packages/plugins`

- Extension 可以贡献受标记来源的 Skill Directory。
- Extension 不能直接把未验证正文插入 System Prompt。

### `packages/server`

- 启动时建立 Skill Registry。
- 增加 List、Reload 和 Diagnostic 协议。
- 只接受 Skill Name 调用，不接受客户端文件路径。

### `packages/web`

- 展示可用 Skill、来源和描述。
- 支持用户选择后发送 `/skill:name`。
- 显示加载失败和冲突诊断。

## 测试与验收

### 必测场景

1. 合法 `SKILL.md` 被发现并索引。
2. 无效名称和描述产生 Diagnostic。
3. 一个损坏 Skill 不影响其他 Skill。
4. 重名 Skill 按确定优先级选择并产生 Warning。
5. System Prompt 只包含 Metadata，不包含全部正文。
6. 用户显式调用会展开正确 Skill。
7. `load_skill` 不能读取未索引路径。
8. `disableModelInvocation` 阻止模型调用但不阻止用户调用。
9. Reload 在 Turn 边界原子替换 Snapshot。
10. 引用资源仍经过普通 Read Tool 权限。

### 验收标准

- 增加十个 Skill 不会把十份正文全部加入每次模型请求。
- Skill 来源和冲突可以被诊断。
- Skill 不能绕过工具权限或读取任意文件。
- Session 恢复后已调用 Skill 的上下文保持确定。
- 关闭 Skills 后 Agent 核心行为不变。

## 学习练习

1. 创建 `code-review/SKILL.md` 并实现 Metadata Parser。
2. 创建一个名称与目录不一致的 Skill，观察 Diagnostic。
3. 同时创建 User 和 Project 同名 Skill，验证优先级。
4. 实现 `/skill:name additional instructions` 展开。
5. 实现只允许索引名称的 `load_skill` Tool。
6. 比较加载 20 个 Skill 前后 System Prompt Token 增长。

## 完成阶段 10–13 后

你应该能够解释：

- 为什么压缩只改变 Context Projection，而不删除 Session。
- 为什么 Session Branch 必须使用不可变 Entry 和 Tip。
- 为什么 Extension 需要两阶段注册和 Stale Context。
- 为什么 Skill 是文本资源，而不是 Tool 或 Extension。
- 为什么大型 Agent 的可扩展性来自明确边界，而不是不断往 Agent Loop 加条件。

