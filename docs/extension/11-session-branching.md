# 阶段 11：Session 分支与时间旅行

## 当前基线与问题

阶段 4 的 Session 可以追加和恢复消息，但仍是线性历史：

```text
A → B → C → D
```

真实交互中，用户可能希望回到 B：

- 换一个 Prompt 重新尝试。
- 使用另一个模型。
- 启用不同工具。
- 放弃错误方向但保留原探索记录。

如果直接截断 C、D：

- 原分支历史丢失。
- 已产生的工具副作用无法解释。
- Session Export 无法复现发生过什么。
- 多次回退后无法知道当前上下文来自哪条路径。

本阶段解决“**怎样把 Session 建模成可持久化的树，并安全地从历史节点继续运行**”。

## 学习目标

- 将线性消息数组升级为父指针 Entry Tree。
- 区分 Tree、Branch、Tip 和 Current Path。
- 从指定 Entry 的前面或后面创建 Fork。
- 在分支间导航时生成可选 Branch Summary。
- 恢复当前分支、配置和待处理状态。

## 非目标

- 不合并两个分支的代码或 Transcript。
- 不实现 Git。
- 不让两个分支共享正在运行的 Operation。
- 不自动判断哪个分支“更好”。
- 不复制外部工具副作用。

## 核心概念

### Entry

Session 中不可变的持久化节点：

```ts
export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  sequence: number;
  timestamp: number;
}
```

消息、压缩和分支摘要都是 Entry：

```ts
export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry;
```

### Branch

Branch 不是 Entry 数组，而是一个名称和 Tip：

```ts
export interface SessionBranch {
  name: string;
  tipId: string | null;
}
```

### Current Path

从当前 Tip 沿 `parentId` 回溯到 Root，再反转：

```text
Root → ... → Current Tip
```

只有 Current Path 会被投影成当前模型上下文。

## 方案比较

### 方案 A：复制消息数组

实现简单，但每次 Fork 都复制大量数据，Entry 身份丢失，也难以共享共同祖先。

### 方案 B：原地截断后继续

不是真正分支，历史会丢失。

### 方案 C：不可变 Entry + Branch Tip，推荐

```text
        C → D   main
       /
A → B
       \
        E → F   experiment
```

A、B 只保存一次，两条分支各自记录 Tip。

## Entry Store 接口

```ts
export interface SessionTreeStore {
  append(
    branch: string,
    entry: NewSessionEntry,
  ): Promise<SessionEntry>;

  getEntry(id: string): Promise<SessionEntry | undefined>;

  getBranch(name: string): Promise<SessionBranch | undefined>;

  listBranches(): Promise<SessionBranch[]>;

  getPath(tipId: string | null): Promise<SessionEntry[]>;

  setBranchTip(
    branch: string,
    tipId: string | null,
  ): Promise<void>;
}
```

`append()` 必须原子地：

1. 读取 Branch 当前 Tip。
2. 把它写入新 Entry 的 `parentId`。
3. 持久化 Entry。
4. 更新 Branch Tip。

不能先广播 Entry，再更新 Tip。

## Fork 语义

```ts
export interface ForkOptions {
  sourceBranch: string;
  entryId?: string;
  position: "before" | "after";
  destinationBranch: string;
}
```

### `after`

新 Branch Tip 指向选中的 Entry：

```text
A → B → C
        ↑
      new tip
```

新 Prompt 会成为 C 的 Child。

### `before`

新 Branch Tip 指向选中 Entry 的 Parent：

```text
A → B → C
    ↑
  new tip
```

适合替换某条 User Message。

必须验证 `entryId` 确实在 Source Branch 的 Current Path 上。

## Fork 与外部副作用

从历史节点 Fork 不等于撤销：

```text
原分支曾执行 write("a.txt")
→ 文件已经变化
→ 回到旧消息节点
→ 文件不会自动恢复
```

因此教学版需要明确提示：

- Transcript 时间旅行不等于环境时间旅行。
- 默认只重建模型上下文。
- 如果未来需要环境 Checkpoint，应作为独立系统实现。

## Branch Configuration

阶段 7 已支持模型和工具动态切换。每条 Branch 应保存自己的运行配置：

```ts
export interface BranchRuntimeConfig {
  model: ModelRef;
  enabledTools: string[];
}
```

从分支 Fork 时复制当时节点对应的配置快照，而不是复制 Source Branch 当前最新配置。

这需要能力变化也以 Entry 或版本化状态持久化。

## 分支导航

```ts
export interface NavigateBranchOptions {
  targetEntryId: string;
  summarizeAbandonedBranch: boolean;
}
```

从 D 导航到 B：

```text
A → B → C → D
    ↑       ↑
 target   old tip
```

需要找到 B 与 D 的最近公共祖先，并收集离开路径上的 Entry。

## Branch Summary

如果用户离开了一条已经产生重要工作的分支，可以生成摘要：

```ts
export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branchSummary";
  fromId: string | null;
  summary: string;
  details?: {
    readResources: string[];
    modifiedResources: string[];
  };
}
```

摘要应表达：

```text
用户曾探索另一条分支
目标是什么
完成了什么
做了哪些决策
修改了哪些资源
为什么离开
```

它与 Compaction Summary 不同：

| 类型 | 目的 |
|---|---|
| Compaction Summary | 缩短当前分支上下文 |
| Branch Summary | 记录被离开的探索路径 |

## Branch Summary 数据流

```text
oldTip 与 target 找公共祖先
       ↓
收集 oldTip 到公共祖先之间的 Entry
       ↓
生成结构化 Branch Summary
       ↓
在目标路径上追加 BranchSummaryEntry
       ↓
更新目标 Branch Tip
```

Tool Result 如果缺少对应 Tool Call，不应单独进入摘要模型上下文。

## Session Fork 与 Branch Navigate 的区别

### Branch Navigate

在同一个 Session Tree 内移动 Current Tip：

```text
一个 Session，多条 Branch
```

### Session Fork

创建一个新的独立 Session：

```text
Source Session Tree
       ↓ copy selected immutable state
Destination Session Tree
```

新 Session 不复制：

- 正在运行的 Operation
- Retry Wait
- Abort 状态
- Pending Tool Effect
- 最终 Run Result

它们属于瞬时或不可安全复制的运行状态。

## 并发与原子性

以下操作必须串行化：

- 同一 Branch 上追加 Entry。
- 更新 Branch Tip。
- Fork 读取 Source Snapshot。
- Navigation 提交 Branch Summary 和新 Tip。

推荐使用 Session Transaction：

```ts
export interface SessionTransaction {
  append(entry: NewSessionEntry): void;
  setBranchTip(branch: string, tipId: string | null): void;
  commit(): Promise<void>;
}
```

不能出现 Entry 已写入但 Tip 未更新的半提交状态。

## 失败与取消

### Fork 目标不存在

返回明确的 `unknown_entry`。

### Entry 不在 Source Path

返回 `entry_not_on_branch`，不能偷偷从另一分支复制。

### Branch Summary 失败

由用户策略决定：

- `summaryRequired: true`：取消导航。
- `summaryRequired: false`：允许不带摘要导航。

默认推荐失败时取消导航，避免悄悄丢失分支上下文。

### 运行中请求导航

- 先请求 Abort 当前 Operation。
- 等待 Agent Idle。
- 再执行导航事务。
- 不把正在生成的流式 Message 作为稳定 Entry。

## 对各包的影响

### `packages/core`

- 新增 `session-tree.ts` 和 `branch-summary.ts`。
- Context Pipeline 从当前 Branch Path 构建消息。
- Agent State 增加 `sessionId`、`branch`、`tipId`。

### `packages/server`

- 管理 Session Tree 和当前 Branch。
- 增加 Fork、Navigate、Create Branch 命令。
- 广播 Tree Snapshot 或增量 Tree Event。

### `packages/web`

- 增加 Session Tree 视图。
- 允许选中历史节点并选择 `before` 或 `after`。
- 清楚提示“不会撤销文件系统副作用”。

### `packages/plugins`

- 阶段 12 可监听 `before_fork`、`after_fork` 和 `branch_changed`。
- 插件不能直接修改 Entry Parent 指针。

## 测试与验收

### 必测场景

1. 两个 Branch 共享共同祖先 Entry。
2. `before` 和 `after` 生成不同 Tip。
3. 非路径 Entry 被拒绝。
4. Current Path 只包含当前分支祖先。
5. Fork 后模型和工具配置来自正确节点。
6. 正在运行时不能直接导航。
7. Branch Summary 包含离开路径而不是目标路径。
8. Session Fork 不复制 Pending Operation。
9. 事务失败不会留下孤立 Tip。
10. 重启后能够恢复 Branch Tree。

### 验收标准

- 可以从任意合法历史节点创建新分支。
- 原分支保持完整且可再次访问。
- 模型只看到当前 Branch Path。
- Session Fork 和 Branch Navigate 语义明确不同。
- 所有 Branch Tip 都指向存在的 Entry 或 `null`。

## 学习练习

1. 手工画出 A-B-C-D 和 A-B-E-F 两条 Branch 的 Parent 指针。
2. 分别对 C 执行 `before` 和 `after` Fork。
3. 写一个 `getPath(tipId)`，处理缺失 Parent 的损坏 Session。
4. 模拟写文件后回到旧节点，解释为什么文件不会恢复。
5. 比较 Branch Summary 与 Compaction Summary 的输入范围。

## 与下一阶段连接

阶段 12 将允许外部模块扩展 Agent。

Extension 可能希望：

- 在 Fork 前确认。
- 自定义 Compaction。
- 注册工具和命令。
- 监听 Session 生命周期。

因此必须设计受控 Hook，而不能让插件直接修改 Session Tree。

