# dsh-mail

通过邮件运行 DSH 任务。插件使用 IMAP 收信，按规则创建 DSH 会话，任务结束后通过 SMTP 回复状态和 Agent 的最后输出。

支持多个邮箱、发件人验证、邮件指定工作目录和文本附件。邮件任务默认使用完整权限，无需审批；同一工作目录的任务依次执行。

## 安装

需要 Bun ≥ 1.4.4、DSH `0.2.2-alpha.2`，以及已开启 IMAP/SMTP 的邮箱。DSH 宿主仍需 Node.js ≥ 24.9；项目的依赖管理、构建和测试使用 Bun。请先在 DSH 中配置好模型。当前从源码安装：

```sh
git clone https://github.com/iMMIQ/dsh-mail.git
cd dsh-mail
bun install --frozen-lockfile
bun run build
bun run dsh plugin --profile web add "$PWD"
cp examples/mail.patch.yml mail.local.yml
```

编辑 `mail.local.yml` 中的邮箱服务器、发件人、结果收件人和数据目录，具体见[配置说明](docs/configuration.md)。本机配置已被 Git 忽略。安装后的插件默认禁用，示例配置会启用它。

提供邮箱授权码，然后启动 DSH：

```sh
export MAIL_PASSWORD='你的邮箱授权码'
bun run dsh --profile web --patch "$PWD/mail.local.yml" --no-open
```

DSH 必须保持运行才能收信、执行任务和发信。在 DSH 会话中运行 `/mail-status` 查看连接状态。

## 使用

从配置允许的地址发送邮件，主题以 `[DSH]` 开头，正文如下：

```text
---
workspace: /srv/projects/my-project
---
检查最近十次提交，修复发现的问题并运行相关测试。
```

`workspace` 必须是 DSH 所在机器上已存在的绝对目录，不需要目录白名单，不展开 `~` 或环境变量。正文开头的配置段只接受 `workspace`。来源验证和权限配置见[配置说明](docs/configuration.md)。

每封命中的新邮件创建一个独立会话。完成、失败、取消、超时或需要核对时，插件自动回复任务状态、会话编号、实际目录、摘要和最后文字输出。邮件不包含思考内容或工具日志，超长输出会缩短，完整内容保留在 DSH 会话中。

当前支持 IMAP/SMTP 和 UTF-8 文本附件。回复邮件会暂存，不会自动续接会话；二进制附件和结果文件附件不受支持。真实邮箱服务商联调尚未完成。

## 管理与开发

任务取消、重试和收发信排查见[故障处理](docs/operations.md)。

```sh
bun run check
```

执行构建、类型检查和测试，无需真实邮箱或模型密钥。修改源码后重新构建并重启 DSH。

## 许可证

[LGPL-3.0-or-later](LICENSE)，授权声明见 [NOTICE](NOTICE)。
