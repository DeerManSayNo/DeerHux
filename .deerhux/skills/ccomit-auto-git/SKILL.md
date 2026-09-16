---
name: ccomit-auto-git
description: |
  自动拉取最新代码、解决冲突、提交并推送。全程无需确认，脚本高度自动化。
  当用户说"自动推送"、"推上去"、"拉代码并推送"、"git sync"、"同步代码"、"快速推送"、"一键 push"、"自动提交推送"等时使用。
---

# Ccomit Auto Git — 一键拉取、解决冲突、提交、推送

高度自动化的 git 同步脚本：`git fetch → rebase → 自动解决冲突 → commit → push`。

## 使用方式

脚本随本 skill 一起位于项目内 `.deerhux/skills/ccomit-auto-git/scripts/git-auto-sync.sh`。Agent 收到触发指令后，进入目标 git 仓库目录执行：

```bash
cd <目标项目目录>
bash .deerhux/skills/ccomit-auto-git/scripts/git-auto-sync.sh [策略] [提交信息]
```

若目标仓库内没有该脚本，再从其他位置查找，不要直接假定路径存在。

### 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 策略 | `theirs` | `theirs`（远程优先）/ `ours`（本地优先）/ `union`（合并保留） |
| 提交信息 | `auto: sync` | 自动提交时使用的 commit message |

### 示例

```bash
# 默认策略（远程优先）
bash .deerhux/skills/ccomit-auto-git/scripts/git-auto-sync.sh

# 本地优先
bash .deerhux/skills/ccomit-auto-git/scripts/git-auto-sync.sh ours

# 自定义提交信息
bash .deerhux/skills/ccomit-auto-git/scripts/git-auto-sync.sh theirs "fix: 解决冲突并同步"
```

## 执行流程

脚本按以下步骤自动执行，无需任何交互：

1. **Pre-flight**: 检查是否在 git 仓库、有 remote、非 detached HEAD
2. **Stash**: 暂存所有未提交的本地改动
3. **Fetch**: `git fetch origin <branch>`
4. **Rebase**: `git rebase origin/<branch> -X <策略>` 自动解决冲突
5. **Fallback**: 如果 rebase 失败 → 逐文件 `git checkout --theirs/--ours` → 继续 rebase；若仍失败 → 改用 `git merge -X <策略>`
6. **Pop Stash**: 恢复之前 stash 的改动，冲突时同样自动按策略处理
7. **Commit**: 如果有改动，`git add -A && git commit -m "<提交信息>"`
8. **Push**: `git push`；若被拒绝 → `git push --force-with-lease`

## ⚠️ 注意事项

- 远程优先 (`theirs`) 是默认策略，意味着冲突时**远程代码会覆盖本地代码**
- 如果用户明确说"保留我的改动"，使用 `ours` 策略
- 如果有 stash 冲突，脚本会强制按策略处理，Agent 执行后应提醒用户 review 改动
- `--force-with-lease` 只在普通 push 被拒绝时才会触发，不会无缘无故 force push
- 脚本执行完毕后，Agent 应简要报告执行结果（成功/失败、是否有冲突）

## 网络：GitHub 直连失败时先走代理

国内网络直连 GitHub 会在 fetch 阶段卡约 75 秒后报 `curl 28 Failed to connect to github.com port 443`。脚本不做代理处理，执行前先确认代理并在同一 shell 导出环境变量：

```bash
nc -z -G 2 127.0.0.1 7897 && export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
bash .deerhux/skills/ccomit-auto-git/scripts/git-auto-sync.sh theirs "提交信息"
```

代理端口不通时再直连。避免把 fetch 失败的 75 秒等待当作正常耗时反复重试。
