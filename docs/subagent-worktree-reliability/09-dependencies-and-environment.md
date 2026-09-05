# 09 依赖与本地环境准备

## 目标

解决临时 Worktree 缺少 ignored 依赖和环境文件的问题，同时避免照搬 Pi 的可写共享 `node_modules` 风险。

## 原则

- Worktree 是源码隔离，不自动等价于完整沙箱。
- 不默认链接可写的主项目 `node_modules`。
- `.env`、数据库和凭据不得被自动复制。
- 环境准备失败不能导致源码成果被清理。

## V1 实现与配置（2026-09-05，章节审查通过）

本章按看板 `BRD-0091` 交付 `none + hook`。`isolated-install` 是已声明但未实现的模式，选择时返回固定 `ENV_MODE_UNSUPPORTED`；不会偷偷执行 npm、访问 registry 或降级为共享依赖。以下配置描述实现行为，章节完成状态以独立审查与测试记录为准。

默认 `none` 只 checkout Git tracked 文件；不补齐 ignored `node_modules`、`.env`、数据库或本机凭据，也不承诺测试环境已经可用。仓库若本来提交了环境文件，Git checkout 仍会包含这些 tracked 文件，不能将“没有自动复制”理解成秘密扫描或净化。

用户可在 DeerHux agent 目录的 `worktree-environments.json` 显式授权一个项目的 hook。仓库内同名文件不能启用 hook，配置路径落在该仓库内会被拒绝。文件格式如下，repository key 必须是项目的 canonical Git 根目录：

```json
{
  "version": 1,
  "repositories": {
    "/absolute/canonical/project": {
      "mode": "hook",
      "script": "scripts/prepare-worktree.cjs",
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "envAllowlist": []
    }
  }
}
```

hook 仅支持仓库相对路径的 `.cjs`、`.mjs`、`.js` Node 脚本（绝对路径不开放）。入口文件必须在固定 `baseCommit` 中是 regular blob，当前字节必须匹配，入口及祖先目录不得为 symlink。通过 Node argv 执行已校验字节的临时快照，cwd 为 `agentCwd`，stdin 是一行 JSON，含 `repoRoot`、`worktreePath`、`agentCwd`、`baseCommit`、`workerId`。脚本成功时 stdout 只能返回一个 JSON 对象，例如：

```json
{"syntheticPaths":[".worktree-generated"]}
```

synthetic 路径相对 Worktree 根目录，必须存在、不能为 tracked 文件或包含 tracked 文件，不能越界、重叠、包含 `.git` 或经过 symlink。manifest 保存路径、类型及文件系统身份。capture 前重新核验，只有安全路径被从专用临时 index 排除；Worker 的实际 index 与 synthetic 文件均不被该排除操作修改。路径变为 tracked、身份被替换或路径不安全时捕获失败并保留 Worktree，不执行递归删除。允许 Worker 自己删除已经不需要的 synthetic 文件。

hook 默认只收到最小运行环境，HOME 指向自己的 Worktree；显式 allowlist 也拒绝敏感变量名和 `NODE_OPTIONS`、`BASH_ENV` 等执行注入变量。hook stdout/stderr 不进入公共 Run 快照，失败只记录固定错误码。Worker 标准 `bash`/`grep` 子进程另使用只读运行时 allowlist，模型传输层的认证不受影响；主 Session 命令环境保持现有行为。

一旦尝试过 hook，setup 失败或取消后保留已经存在的 Worktree/branch，即使瞬间看起来 clean。hook 可以执行项目代码，其依赖、相对 imports 和同 UID 并发写入并不是强隔离；无进程沙箱时无法承诺防御恶意脚本主动读取主目录、凭据或修改共享 Git 元数据。配置 hook 前必须信任其代码，不能把环境变量过滤当作安全沙箱。

测试入口：`npm run test:worktree-environment`，包含真实 Bash、环境模块、真实 Git 集成和独立红队，已加入 `test:core` 前置门禁。独立审查已发现 P0/P1 清零；自动安装、包管理器缓存、reflink、网络失败安装恢复不属于本次 V1 验收。有限 hook 不允许常驻服务，成功或失败退出都会终止原进程组残留；脱离进程组的恶意进程仍在 OS 沙箱未提供的边界之外。

## 策略设计 TODO

- [x] `ENV-0901` 定义 `worktreeEnvironmentMode: none | hook | isolated-install`，默认值先采用 `none`。
- [x] `ENV-0902` `none` 明确表示只提供 Git tracked 文件，不隐式承诺测试环境可用。
- [x] `ENV-0903` `hook` 允许项目提供受控、仓库内声明的准备脚本，必须另由用户侧配置显式授权。
- [ ] `ENV-0904` `isolated-install` 在每个 Worktree/Run 建立独立依赖目录，不共享可写目录。
- [x] `ENV-0905` 不提供名为 `shared` 的默认模式；若未来增加，必须先有文件系统只读或进程沙箱保证。

## Setup Hook TODO

- [x] `ENV-0910` hook 配置只接受仓库相对路径；V1 不开放绝对路径。
- [x] `ENV-0911` hook 文件本身必须是 tracked regular file，拒绝 symlink。
- [x] `ENV-0912` hook 接收结构化 stdin：repoRoot、worktreePath、agentCwd、baseCommit、workerId。
- [x] `ENV-0913` hook 设置执行超时、输出上限和 AbortSignal。
- [x] `ENV-0914` hook 返回 synthetic paths；逐项验证位于 Worktree 内且不是 base/HEAD/index tracked 文件，拒绝大小写别名。
- [x] `ENV-0915` 捕获 Diff 在专用临时 index 排除 synthetic paths，不物理删除；核验失败保留并记录固定错误码。
- [x] `ENV-0916` hook 失败进入 setup rollback；尝试过 hook 的现存目录保守保留，结果写 manifest。
- [x] `ENV-0917` hook stdout/stderr 不写入公共 Run 快照，只透出固定错误码。

## Isolated Install TODO

- [ ] `ENV-0920` 检测 lockfile 和 package manager，禁止无 lockfile 的隐式安装。
- [ ] `ENV-0921` npm 使用锁定安装语义；pnpm/yarn 采用对应 frozen lockfile 参数。
- [ ] `ENV-0922` 安装缓存可共享，但安装目标目录必须按 Worktree 隔离。
- [ ] `ENV-0923` 安装命令默认禁用交互并设置明确超时。
- [ ] `ENV-0924` 安装失败标记环境不可用，但保留 Worktree供用户修复/Continue。
- [ ] `ENV-0925` 记录依赖准备耗时、缓存命中和错误码，不记录 registry token。
- [ ] `ENV-0926` 同一 Run 多 Worker可选使用 APFS clone/reflink 优化，但必须先验证写时复制语义；不支持时回退独立安装。

## 环境文件 TODO

- [x] `ENV-0930` 不自动复制 `.env*`、数据库、credentials、SSH 文件和云配置。
- [x] `ENV-0931` 提供显式的只读环境变量 allowlist，不把全部父进程环境透传给 Worker 标准命令；不改变宿主模型认证。
- [x] `ENV-0932` 本地服务地址、测试数据库等通过项目配置声明，不写入 patch。
- [x] `ENV-0933` 去掉 synthetic 物理删除路径；capture 前复核类型/身份/symlink/跟踪状态，替换时拒绝并保留。

## 测试 TODO

- [x] `ENV-0940` 真实 fixture 证明两 Worker 修改 hook 创建的自有依赖不改变主项目 `node_modules`；不声称约束恶意 Bash。
- [ ] `ENV-0941` 两个并行 Worker安装依赖不会竞争同一目标目录。
- [x] `ENV-0942` hook 创建、篡改、删除 synthetic path 的测试。
- [ ] `ENV-0943` lockfile 缺失、网络失败、超时、磁盘不足测试。
- [x] `ENV-0944` fixture 验证主项目 ignored `.env` 不自动复制、敏感继承变量被过滤、公共快照无 hook 输出或内部环境字段；不承诺扫描用户主动写入或已 tracked 的秘密。

## 验收标准

- [x] 默认环境准备不链接/写入主项目 ignored 目录。
- [x] 环境准备方式可解释、可取消，synthetic 不污染 Diff；成果清理由既有保守生命周期管理，不新增物理删除授权。
- [x] 环境失败不改变 Worktree 数据安全语义。
