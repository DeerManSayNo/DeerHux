# 分享窗口（最小实现）

## 使用

主人点击右上角设置菜单中的「分享窗口」，在创建页选择项目、模型、角色和有效期，右侧实时展示权限摘要；创建成功后可一键复制链接和匹配码，管理页可停止已有分享。默认只读；勾选「允许新增和修改项目文本文件」后允许写入。创建后将链接和匹配码分别复制给访客。同一设备多张网卡时会列出多个链接，使用对方可达的局域网地址。

访客验证匹配码后选择授权的项目、角色、模型并新建窗口。每个访客最多 12 个会话，最多同时显示 3 个窗口。点击窗口标签可以隐藏或重新显示，历史在当前主人进程内保留。复用原生 ChatInput 与 MessageView，支持输入、实时回复、工具结果、停止、复制和回到底部。

主人可停止分享；有效期届满自动失效。停止后拒绝新请求并中止执行。调整资源或权限时停止旧分享并重新创建。

## 最小版本范围

- 分享、匹配码验证身份与会话保存在当前进程内；重启主人应用后失效，不公开主人原有会话。
- 项目固定在会话创建时，模型与角色从分享允许列表中选择，角色使用创建分享时的内容快照。更换组合时新建窗口。
- 专用工具仅支持目录列举、读取以及授权后的创建/覆盖文本文件，单文件最多 200KB。父目录必须存在。
- 不提供终端、MCP、扩展、子 Agent、定时任务、附件上传、文件删除和自动修改角色记忆。
- 运行中的 DeerHux 代码与配置目录不能启用写入分享，防止通过热更新代码扩大执行权限。文件访问拒绝绝对路径、路径穿越、隐藏路径、符号链接、硬链接、设备文件和常见密钥文件。只读分享不注册写入工具，实际文件写入仍重新鉴权。
- 主人自己的工作目录操作、其他本机进程或操作系统被攻破不属于访客 API 的隔离边界；本实现不运行访客任意程序，不宣称提供通用进程沙箱。
- 默认采用可信局域网 HTTP。配置公网入口后，使用 HTTPS 反向代理和 SSH 反向隧道，分享网关仅绑定回环地址；项目、模型密钥和引擎留在主人设备。

## 实现

`lib/sharing/gateway.ts` 按需监听独立随机端口，仅允许私有 IPv4 / 回环连接。只代理分享页面和 Next 静态资源；不转发原生 API、Server Actions、Cookie、访客请求头或开发调试接口。主人原始服务必须绑定回环地址，创建分享时检测原端口是否仍向局域网开放，不满足时拒绝启动。

`lib/sharing/service.ts` 负责安全随机生成的 6 位数字匹配码（保留前导零）、带盐 scrypt 验证、每分享每分钟最多 10 次验证、访客 Cookie、资源白名单、会话归属、到期及撤销。接口拒绝未知字段，所有会话请求验证 shareId 与 guestId；最多 20 份分享、每分享 30 个访客、全局 100 个会话及 4 个并发回合，每会话最多 100 回合。

分享会话通过生产工厂使用 DeerLoopEngine，模型凭据仅留在主人端。使用专用工具，不经过原生 Wrapper 的任意 RPC 命令接口。引擎运行目录与共享项目分离，项目操作统一经过 `lib/sharing/files.ts`。访客按会话读取约 700ms 一次的消息快照，不接入宿主全局 SSE；工具调用统一通过 normalizeToolCalls 转换。

主人管理入口是 `app/api/shares/route.ts` 与 `components/ShareManager.tsx`。访客入口是 `app/share/[id]/page.tsx` 与 `components/SharedWorkspace.tsx`。ChatInput 的 textOnly 接口关闭本机角色/技能发现与附件入口，其他调用保持原行为。

开发命令与 CLI 默认绑定 127.0.0.1，Tauri 启动器已采用相同绑定。Next 16 的 reactDebugChannel 关闭，避免分享页等待不对外开放的开发 WebSocket 才能水合。不会转发调试端口来解决开发页面加载问题。开发模式通过 Next 的 `instrumentation-client.ts` 在客户端启动前为分享页面安装 HMR 禁用逻辑（`lib/sharing/dev-client.ts`），不在 React 布局中渲染脚本标签：仅拦截同源 `/_next/webpack-hmr`，避免 Next 在 26 次连接失败后自动刷新整页；主人页面和其他 WebSocket 保持原生行为，生产模式不注入此脚本。

## 验证

```sh
node_modules/.bin/tsc --noEmit
npm run lint
node --experimental-strip-types --disable-warning=DEP0205 --import ./scripts/register-typescript-test-loader.mjs scripts/test-sharing.ts
```

自动化测试使用独立临时项目和模拟引擎，不使用主人模型凭据；覆盖只读、授权写入、路径穿越、链接、访客隔离、资源参数和命令伪造、匹配码限流、失效后工具执行、真实 HTTP 网关、静态资源编码及原生接口拒绝。

真实浏览器与局域网 HTTP 联调的检查不等于第二台设备验证，也不等于 Tauri release 打包验证。开发期间禁止运行 next build。

## 公网部署

主人开发环境的 `.env.local` 设置 `DEERHUX_SHARE_PUBLIC_ORIGIN`（不带尾斜杠的 HTTPS origin）和 `DEERHUX_SHARE_PORT`（固定端口），重启应用后生效。生产运行时向 Node 进程注入同名环境变量。配置公网入口后只生成 HTTPS 链接，登录 Cookie 启用 Secure，并要求代理传入匹配的 Host 与 `X-Forwarded-Proto: https`。这些代理头只在回环监听的网关上使用，不能代替匹配码和每次请求的权限校验。

当前部署使用本机 127.0.0.1:30142 → SSH 反向隧道 → 服务器 127.0.0.1:43142 → Nginx HTTPS。SSH 启用传输压缩（`-C`），Nginx 对 HTML、JavaScript、CSS、SVG 启用 gzip，降低开发资源经过公网往返的体积。专用 SSH 用户只允许该远程转发端口，禁止会话和密码登录。macOS LaunchAgent `site.deerhux.share-relay` 在用户登录后运行、掉线自动重连；主人设备需联网且应用运行，休眠或退出期间无法交互。分享网关按需启动，因此首次创建分享前入口可能返回 502。

服务器配置：`/etc/nginx/conf.d/deerhux-share.conf`、`/etc/ssh/sshd_config.d/60-deerhux-relay.conf`。证书由 Certbot 定时续期，deploy hook 校验并重载 Nginx。本机隧道配置位于 `~/Library/LaunchAgents/site.deerhux.share-relay.plist`，密钥在 `~/.ssh/deerhux_share_relay`，不进入仓库。切换域名需先配置 DNS 和证书，再同步代理 server_name 与主人环境变量；已有应用服务不迁移。

公网验证覆盖 HTTPS 证书校验、匹配码登录、Secure Cookie、创建窗口、未授权 API 拒绝、撤销失效；不开放宿主原始端口。停止中继可执行 `launchctl bootout gui/$(id -u)/site.deerhux.share-relay`；恢复局域网模式需移除上述环境变量并重启应用。

界面样式统一于 `components/sharing/sharing.module.css`，共享图标、复制反馈与错误提示位于 `components/sharing/ShareUI.tsx`。主人弹窗采用原生 dialog，访客工作台采用资源侧栏与聊天画布，支持明暗主题与窄屏布局。

主人管理列表可重新查看和复制匹配码。匹配码显示值仅保留于当前进程，随分享撤销或进程退出移除；只经本机主人 API 返回并禁用响应缓存，访客 catalog 不包含匹配码。旧版内存分享仅保留哈希时，主人可显式生成新码：链接和权限保持不变，旧码失效，已登录访客保持会话；重复请求返回同一新码。

永久有效期使用 `hours: null` 创建，服务端以 `expiresAt: null` 表示并跳过自动到期判断；仍支持手动撤销，且遵循当前进程内存生命周期。有限时长仍限制为 1–168 小时。
