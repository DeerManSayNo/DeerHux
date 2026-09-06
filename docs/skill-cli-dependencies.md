# Skill CLI 环境标签

在 `SKILL.md` 的 YAML frontmatter 中声明 `cli-dependencies`，Skill 面板会显示检测结果和安装入口：

```yaml
cli-dependencies:
  - command: example-cli
    install-url: https://example.com/download
    platforms: [darwin, linux, win32]
```

- `command`：必填，只接受命令名称，不接受路径、参数或 shell 表达式。
- `install-url`：可选，HTTP(S) 安装说明或下载页面。作为安装来源记录；自动安装命令由应用维护，不能通过此地址指定执行内容。
- `platforms`：可选，支持的 Node.js 平台名；省略表示不限制平台。
- 也可用字符串数组只声明命令，如 `cli-dependencies: [git, python3]`。

打开面板时检测；一键安装成功后自动检测，也可点击“重新检测”更新状态。检测查找 DeerHux 服务进程的 PATH，并在 macOS/Linux 下额外查找 `~/.local/bin`。只检查普通文件及执行权限，不执行命令，不验证版本、认证或后台服务。PATH 变更未被进程继承时，需重启 DeerHux。

没有声明的 Skill 不显示 CLI 标签，不从自然语言正文猜测依赖。内置 webcmd-browser 已声明 webcmd 命令和项目安装地址；其 CLI 可在面板点击“下载”安装，浏览器运行环境按 webcmd doctor 提示配置；Skill 及 references 随应用打包。

## 一键下载与安装

缺少 CLI 时，已配置安装方式的命令显示“下载”按钮：

- `webcmd`：执行 `npm install -g @agentrhq/webcmd`。
- `tvly`：macOS/Linux 下载并执行官方 `https://cli.tavily.com/install.sh` 安装脚本。

安装成功后自动检测；失败时显示错误与安装输出。相同 CLI 的并发安装请求合并。未知 CLI 或不支持的平台不执行安装。新增安装方式需在应用的 `lib/skill-cli-installers.ts` 和 `lib/skill-cli-install.ts` 中配置，Skill 和请求均不能传入任意 shell 命令。
