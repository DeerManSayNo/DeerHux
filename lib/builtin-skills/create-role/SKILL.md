---
disable-model-invocation: false
name: create-role
description: 创建、修改或删除 DeerHux 角色及其长期设定。
---

# 角色管理

角色包含身份、基础提示词和跨 Session 生效的设定。仅本次对话的要求不写入角色库。

先展示拟保存的角色名称、设定内容和作用范围（全局或项目），用自然语言请用户确认；用户已明确确认这份方案时不重复询问。只在确认后执行写入，成功后才说明已保存。客户端也有长期设定确认入口；同一设定已经由客户端保存时不要重复新增，先读取核对。

## 使用内置 API

通过 `bash` 调用本机 DeerHux API。后端进程环境变量 `PORT` 是桌面应用实际端口；开发环境未设置时使用 30141。Base URL 为 `http://127.0.0.1:<端口>`。连接失败时说明无法保存，不直接改角色配置文件。

- `GET /api/roles?cwd=<编码后的项目绝对路径>`：读取可用角色，以返回的 ID 和 `sourceInfo.scope` 定位目标，不把名称当 ID。目标不明确时询问用户。
- `POST /api/roles?cwd=...`：创建角色，JSON 包含 `name`、`description`、`basePrompt`、`scope`（`user` 或 `project`）。项目角色须提供 cwd；未指定范围时创建为全局角色并在确认方案中注明。
- `POST /api/roles/{id}/settings?cwd=...`：新增长期设定，JSON 为 `{ "block": "Rules", "text": "设定内容" }`。block 可为 `Identity`（身份）、`Soul`（风格）、`Rules`（行为）、`User`（偏好）、`Tools`（工具）、`Memory`（背景记忆）。
- `PATCH /api/roles/{id}?cwd=...`：修改名称、描述、基础提示词或 `blocks`。修改或删除某条设定时，先读取完整角色，仅调整目标条目，保留其他块、条目及其 ID，再提交完整 blocks。不要将删除设定误做删除角色。
- `DELETE /api/roles/{id}?cwd=...`：删除整个角色，仅在用户确认删除该角色后使用；默认角色不可删除。

修改全局角色时省略 cwd；项目角色使用其项目 cwd。用 JSON 序列化请求体，避免把用户文本直接拼进 shell 命令。检查 HTTP 状态和响应内容，失败时不要声称成功；写入后重新 GET 核对，返回新增或更新的角色名称。保存不等于切换当前会话角色，提醒用户在角色选择器中选用或重新选用该角色。
