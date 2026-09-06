---
name: create-scheduler
disable-model-invocation: false
description: |
  DeerHux 内置定时任务系统。当用户要求创建、修改、删除、查看定时任务，或说"定时"、"每天几点"、"定期执行"、"自动查询"、"cron"、"计划任务"时，使用本技能。通过 REST API 操作 DeerHux 自带的调度器，任务会显示在客户端的「定时任务」面板中。
---

# DeerHux Scheduler — 内置定时任务

DeerHux 有内置的 node-cron 调度引擎，支持两种任务类型，通过 REST API 操作。

## ⚠️ 重要

**凡是用户要求创建定时任务，必须使用本技能调用 DeerHux 内置 API，不要使用 launchd / crontab / systemd 等系统级工具。**

## 任务类型

| 类型 | 说明 | config 字段 |
|------|------|-------------|
| `prompt` | Agent 自动对话执行 | `{ cwd, message, model?, toolNames? }` |
| `shell` | 执行 Shell 命令 | `{ cwd, command }` |

## API 端点

DeerHux 运行在 `http://localhost:30141`（开发模式）或 DeerHux 内置端口。

### 1. 创建任务

```bash
curl -s -X POST http://localhost:30141/api/scheduler \
  -H "Content-Type: application/json" \
  -d '{
    "name": "任务名称",
    "type": "prompt",
    "cron": "40 13 * * *",
    "config": {
      "cwd": "/path/to/project",
      "message": "要执行的 prompt 内容"
    }
  }'
```

### 2. 查询所有任务

```bash
curl -s http://localhost:30141/api/scheduler
```

### 3. 更新任务

```bash
curl -s -X PATCH http://localhost:30141/api/scheduler/{任务ID} \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### 4. 删除任务

```bash
curl -s -X DELETE http://localhost:30141/api/scheduler/{任务ID}
```

## Cron 表达式参考（5 位）

| 表达式 | 含义 |
|--------|------|
| `40 13 * * *` | 每天 13:40 |
| `0 9 * * *` | 每天 9:00 |
| `0 9 * * 1-5` | 工作日 9:00 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 */2 * * *` | 每 2 小时 |

## Prompt 任务示例

```json
{
  "name": "每日新闻查询",
  "type": "prompt",
  "cron": "40 13 * * *",
  "config": {
    "cwd": "/Users/huanghaoqi/deerhux-cwd",
    "message": "使用 tvly search 搜索今天的中文重大新闻、科技新闻，汇总保存到 ~/news/YYYY-MM-DD.md"
  }
}
```

## 注意事项

1. **API 端口**: 开发模式用 30141，打包后可能不同；如果 curl 连不上，改为直接写 `~/.deerhux/agent/scheduled-tasks.json`
2. **任务创建后**: 提醒用户重启 DeerHux 客户端使 cron 调度生效（API 数据会保存，但 node-cron 在服务启动时加载）
3. **env 变量**: prompt 任务中的 message 应包含完整指令，Agent 会自动执行，不需要用户确认
4. **错误处理**: 如果 API 返回错误，检查 cron 格式是否有效、config 字段是否完整
