# dsh-mail

通过邮件运行 DSH 任务。插件使用 IMAP 收信，按规则创建 DSH 会话，任务结束后通过 SMTP 回复状态和 Agent 的最后输出。

支持多个邮箱、发件人验证、邮件指定工作目录和文本附件。邮件任务默认使用完整权限，无需审批；同一工作目录的任务依次执行。

## 安装

需要 Bun ≥ 1.4.4、DSH ≥ `0.2.1-alpha.3`（首次提供 Remote 辅助接口的版本），以及已开启 IMAP/SMTP 的邮箱。DSH 宿主仍需 Node.js ≥ 24.9；项目的依赖管理、构建和测试使用 Bun。请先在 DSH 中配置好模型。当前从源码安装：

```sh
git clone https://github.com/iMMIQ/dsh-mail.git
cd dsh-mail
bun install --frozen-lockfile
bun run build
bun run dsh plugin --profile web add "$PWD"
bun run dsh --profile web --no-open
```

打开 DSH，进入 **插件 → 已安装 → dsh-mail → 包含的组件 → 配置**：

1. 添加邮箱，填写 IMAP/SMTP 服务器、端口、连接安全和邮箱授权码。收发信可共用授权码，也可分别配置。
2. 添加规则，设置允许的发件人、主题前缀和结果收件人。
3. 保存，检查连接，再开启“接收并执行邮件任务”并保存。

授权码由 DSH 凭据存储管理，保存后只显示“已设置”；留空保留原值。连接检查只验证登录，不发送邮件。插件首次安装处于暂停状态，DSH 必须保持运行才能处理邮件。手动配置和来源验证见[配置说明](docs/configuration.md)。

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

CI 使用各版本配套的 Cordis 依赖，验证最低支持版与最新版的构建和全部测试。可用 `bun run test:compat 0.2.1-alpha.3` 在独立临时目录中验证指定版本。

## 许可证

[LGPL-3.0-or-later](LICENSE)，授权声明见 [NOTICE](NOTICE)。
