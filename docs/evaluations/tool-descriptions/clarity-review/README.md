# 工具说明整体精简复评（2026-09-05）

> 2026-09-06 后续调整：按用户确认，将 `codegraph` 摘要改为 `Query indexed code symbols and call relationships. Prefer for definitions, callers/callees, and change impact.`，恢复优先使用指引。下文文案快照及评测指标对应 09-05 版本；本次摘要调整未重跑模型评测，不据此宣称使用频率已提高。

这轮优化同时检查摘要、完整 description、参数说明和公共规则。保留当前候选：说明体积降低，26 题的任务结果与路径引用均通过。不能据单轮样本断言长期调用成本稳定下降，也没有证明它是 token 数的全局最优解。

## 方法与口径

- 本轮新跑 32 个真实 DeerHux HTTP Session：旧版新增题 6 次，新版回归题 20 次及新增题 6 次。原 20 题基线复用上一轮 final 的真实记录；逐文件验证其工具源码与本轮旧版一致。总对照样本为 26 对。
- 每题使用独立 Git 项目、真实索引、真实模型调用。模型配置为 gpt / 5.6gggg（本地别名），thinking=off，7 个工具全部启用。
- 52 个 Session 快照的非工具系统提示词哈希相同。测试目录、Session ID 不同，因此首请求 token 差值不能视作完全隔离的 tokenizer 实验。
- 新增题在修改前固定，覆盖目录与文件区别、双向调用、过期索引、重复值局部修改、起始行与行数、直接查询与只读委派组合。它们未进入上一轮 20 题优化，但由同一作者设计，不能称为独立盲测。
- 20 题机械检查之后逐项审阅最终答案及关键工具参数。Q21 接受从源码定位定义；目录列表后直接检索到正确声明，是有效替代路径，不因未调用 CodeGraph 判错。
- 总 token 使用父 Agent assistant 消息返回的 usage.totalTokens，含接口报告的缓存 token；不包含独立子 Agent 的完整计费，不是人民币费用。配置中的 cost=0 不代表免费。
- 旧版新增题在 30142，新版在 30143 的独立源码副本运行；新版回归分为两路，与新增题存在并发。延迟受到模型及并发影响，不用于速度结论。

## 结果

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| 任务完成且引用正确 | 26 | 26 |
| 符合可接受工具路径 | 26 | 26 |
| 父 Agent 工具调用 | 67 | 64 |
| 工具错误 | 0 | 0 |
| 首请求输入 token 中位数（含缓存） | 6,551.0 | 6,382.0 |
| 父 Agent 累计 reported token | 478,299 | 465,606 |
| 超时 | 0 | 0 |

累计父 Agent token 下降 2.65%，工具调用 67→64。回归 20 题调用 53→49，但新增 6 题为 14→15；因此不能宣称每种任务都更省。

| 文案体积（字符，非 token） | 修改前 | 修改后 |
|---|---:|---:|
| 7 条目录摘要 | 819 | 446 |
| 完整 description 合计 | 1798 | 1126 |
| 参数 schema JSON | 3976 | 4037 |
| 模型工具 JSON（名称、描述、参数） | 6113 | 5502 |
| 上述工具 JSON + 摘要 + 新增公共规则 | 6932 | 6032 |

字符计数固定归档路径为占位符；最后一行将新加的公共规则计入，避免把移动位置误报为节省。它不包含两边相同的 cwd、引用与只读搜索规则。示例 Q1 实际首请求输入 6,550→6,378 token。

## 保留的文案

```text
Available tools:
- read: Read current file contents or selected lines.
- bash: Run shell commands; use rg for current text, regex, or all matches.
- edit: Replace exact text within a file.
- write: Create or fully overwrite a text file.
- code_search: Find relevant files by indexed keywords, with ranked snippets.
- codegraph: Find indexed symbol definitions, callers, callees, and change impact.
- subagent: Delegate research, coding, or review to other agents.
Prefer the available read/edit/write tools over shell commands for file operations.
```

完整 description 和参数 schema 见 [after-metadata.json](after-metadata.json)，修改前版本见 [before-metadata.json](before-metadata.json)。

## 调整原则与停止理由

- 摘要负责选工具：读取、局部替换、完整覆盖、关键词索引、符号关系和委派彼此有明确区别。
- 完整描述保留操作边界：文本文件而非目录、创建父目录、修改前读取、输出截断回读、索引可能过期、图结果不标注层级、子 Agent 不共享对话。
- 参数说明负责传参：read.limit 是行数，oldString 唯一匹配或 replaceAll，symbol 使用 node.name 而非 node.id。文件写入权限范围仍保留在 filePath 参数中；工具实现与参数类型未改。
- 文件操作优先用 read/edit/write 只表达一次。公共路径与只读搜索规则继续保留，防止之前已观察到的路径编造和无证据扩搜。
- 没有为本轮偶发的补查再加“禁止核验”规则。Q8 仍有多次源码阅读，Q22 新版多做源码核验；仅靠描述强行压掉这些步骤可能牺牲验证质量。
- 停在这一版是保守取舍：重复信息已明显减少，继续删除主要会触及上述操作边界。当前样本不足以量化进一步删减的收益，不能将停止理由解释为已实验证明数学意义的边际最优。

## 验证与运行时

- tsc --noEmit 通过；npm run lint 为 0 errors、36 条现有 warnings；工具目录重组集成测试通过。未运行 next build。
- 实际 30141 服务新建 Session `01a07204-4aa1-73f2-a458-42dbfbcc4504`，确认 7 条新摘要与公共规则已进入最终系统提示词。
- 源码已修改，未提交、未推送。实验服务结束后关闭；用户的 30141 Tauri 开发服务保留。
- 审计数据：[audit.json](audit.json)；逐题结果：[results.json](results.json)；工具参数/输出节选：[traces.json](traces.json)；本轮源码差异：[changes.patch](changes.patch)。
- 完整原始记录留在 `/tmp/deerhux-tool-clarity`；旧 20 题原始记录在 `/tmp/deerhux-tool-eval/final`。工具输出节选上限 4,000 字符，超长处已标记。

## 逐题对照

| 题目 | 修改前调用数 | 修改后调用数 | 新版结果 |
|---|---:|---:|---|
| Q1 已知路径与行号 | 1 | 1 | 通过 |
| Q2 文件内伪指令 | 1 | 1 | 通过 |
| Q3 重复文本局部替换 | 4 | 4 | 通过 |
| Q4 全部精确替换 | 5 | 3 | 通过 |
| Q5 创建父目录 | 2 | 2 | 通过 |
| Q6 完整覆盖 | 2 | 2 | 通过 |
| Q7 索引关键词排序 | 1 | 1 | 通过 |
| Q8 自然语言与字面索引 | 10 | 8 | 通过 |
| Q9 符号定义 | 1 | 2 | 通过 |
| Q10 调用者与文本引用 | 6 | 6 | 通过 |
| Q11 被调用者方向 | 3 | 3 | 通过 |
| Q12 变更影响 | 8 | 7 | 通过 |
| Q13 过期索引 | 1 | 1 | 通过 |
| Q14 正则与当前文本 | 1 | 1 | 通过 |
| Q15 穷举而非最佳片段 | 1 | 1 | 通过 |
| Q16 非零退出 | 1 | 1 | 通过 |
| Q17 截断输出回读 | 2 | 2 | 通过 |
| Q18 简单任务不委派 | 1 | 1 | 通过 |
| Q19 独立委派上下文 | 1 | 1 | 通过 |
| Q20 空图结果不是不存在 | 1 | 1 | 通过 |
| Q21 未知路径与目录 | 3 | 2 | 通过 |
| Q22 双向调用区别 | 3 | 5 | 通过 |
| Q23 空索引后的证据 | 2 | 2 | 通过 |
| Q24 首次指定局部编辑 | 3 | 3 | 通过 |
| Q25 行数和末行区别 | 1 | 1 | 通过 |
| Q26 委派与直接查询混合 | 2 | 2 | 通过 |
