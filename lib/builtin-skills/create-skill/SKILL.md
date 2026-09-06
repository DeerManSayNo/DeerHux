---
name: create-skill
disable-model-invocation: false
description: 创建或修改可复用的 DeerHux Skill，包括触发描述、操作指南和必要的辅助文件。
---

# 创建 Skill

将可复用的任务知识写成按需加载的 Skill。先检查已有 Skill，更新相关技能，避免创建重复项。用户要求优先；只在用途或必需信息不明确时询问。

## 保存位置

遵循用户指定范围。未指定时保存到全局技能目录：环境变量 `DEERHUX_CODING_AGENT_DIR` 或 `PI_CODING_AGENT_DIR` 指定的 Agent 目录下的 `skills`，默认 `~/.deerhux/agent/skills`。项目专用 Skill 放在当前项目的 `.deerhux/skills`。

目录名使用小写字母、数字和连字符，不超过 64 字符；与 frontmatter 的 name 一致。不要写入应用安装目录，也不要把普通新建 Skill 声称为应用内置功能。

## 内容

每个 Skill 必须有 `SKILL.md`：

```markdown
---
name: example-skill
description: 说明这个技能完成什么任务，以及何时使用。
---

# 技能名称

完成任务所需的关键知识、流程与约束。
```

- description 会进入技能目录，保持简短、具体，明确触发条件；不要在其中堆放操作步骤。
- 正文只写影响任务决策的知识，不重复通用助手能力和系统规则。保留用户明确的偏好，不把一次任务的细节固化成普遍限制。
- 常规 Skill 默认允许自动匹配；只有用户要求仅手动调用时才设置 `disable-model-invocation: true`。
- 只有确有用途时才添加 `scripts/`、`references/` 或 `assets/`。在正文中用相对路径说明何时读取或运行辅助文件，不预先加载全部资料。
- 不引用当前环境不存在的工具、脚本或其他 Skill。不要使用 Codex 专属配置文件代替 DeerHux 的 SKILL.md 配置。
- 流程中的写入和外部操作应遵守用户授权；只有任务本身确需确认时才设置确认步骤，避免重复询问。

## 写入与验证

使用 `read` 检查现有文件，`edit` 修改、`write` 新建；保留与此次修改无关的内容。若工具不可用，说明限制，或使用当前可用且获授权的文件操作方式。

检查 frontmatter 的 name、description、目录名和相对链接，移除占位内容。新增脚本需在隔离目录中执行验证；对复杂流程选取真实输入检查结果，不只检查文字是否存在。测试不得无故操作真实账号、发布内容或改写用户数据。

完成后说明保存路径、用途和实际验证结果。文件已保存不代表当前 Session 的技能目录已重载；需要时让用户刷新技能列表，并在新建或重载 Session 后使用。
