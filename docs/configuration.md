# 配置

在 DSH 的 **插件 → 已安装 → dsh-mail → 包含的组件 → 配置** 中填写邮箱地址、邮件服务器、密码和允许的发件邮箱，再点击“保存并启用”。页面自动建立任务规则，并在收发连接检查通过后启用；结果默认回信到第一个允许的发件邮箱。首次安装处于暂停状态，其他选项折叠显示。密码写入 DSH 凭据存储，不写入普通配置，也不会回显；环境变量提供的只读凭据需要在宿主环境中修改。

需要手动配置时，从 [mail.patch.yml](../examples/mail.patch.yml) 复制本机配置，通过 `--patch` 加载，或写入 profile 的 `cordis.patch.yml`。插件行的 `id` 为 `mail-automation`；profile 补丁替换整段 `config`，不会逐字段合并。`enabled: false` 暂停收发和任务执行。启动参数覆盖的字段可能在 UI 中只读。

## 邮箱与数据目录

- `stateDirectory`：可写的绝对目录，用于原始邮件和本机运行锁，默认 `~/.dsh/mail`。多个实例需使用不同目录；迁移时保留原有邮件数据。
- `accounts[].id`：账户名称，供规则引用。
- `accounts[].address`：该账户的邮箱地址。
- `receive` / `send`：分别配置 IMAP 和 SMTP；一个账户可仅用于收信或发信。
- `host`、`port`、`tls`：按服务商填写。`direct` 表示直接 TLS，`starttls` 表示 STARTTLS；证书必须可信。内部 CA 的 PEM 公钥证书可填入 `ca`，也可在 UI 的服务器选项中粘贴。
- `auth.user`、`auth.credentialRef`：登录名和 DSH 凭据名称。密码通过 DSH 凭据来源提供，不写入补丁。

多个邮箱分别使用不同的 `id` 和凭据名称。收信账户默认监听 `INBOX`，首次启动只建立基线，不执行历史邮件；`receive.initialSync: all` 可在首次建立游标时扫描历史邮件，仍受邮件年龄限制。默认最大邮件年龄为两天，重新启动不会重置游标。

示例通过环境变量 `MAIL_PASSWORD` 提供邮箱授权码；也可以使用已有的 DSH 凭据存储。示例沿用 DSH 当前默认 Agent 模式和模型；默认的 `danger-full-access` 权限 preset 必须存在于所选 profile。

## 发件人验证

每条规则指定来源策略和 `allowedSenders`，新建规则默认使用 DKIM 验证。内部邮箱可在 UI 的邮件识别选项中填入“信任的内部邮箱”，或配置 `senderPolicies.<id>.trustedSenders`；仅对这些完整邮箱地址跳过签名验证，仍须命中允许发件人列表。

示例使用本地 DKIM 验证：

```yaml
senderPolicies:
  signed:
    evidence: local-signature
```

此策略要求签名有效、覆盖完整正文，签名域与 From 域完全一致；存在的 From、To、Subject、Message-ID、References 和 In-Reply-To 头均须被签名且不能重复。某些服务商的签名不满足这些要求，可先用 `/mail-dry-run` 检查。自定义 DNS 可通过该策略的 `dnsServers` 设置。

如果使用自己控制的邮件服务器，可改用它的认证结果：

```yaml
senderPolicies:
  company:
    evidence: trusted-mta
    authservIds: [mx.example.com]
    stripsUntrustedHeaders: true
```

服务器必须清除外来邮件伪造的同名认证头，并生成 `Authentication-Results: mx.example.com; dmarc=pass header.from=example.com` 形式的结果。当前仅接受这种简单格式，含注释、引号或复杂扩展的认证头无法通过。

## 连续对话与通知

回复已知通知邮件会继续原会话，沿用其工作目录；请在引用历史上方填写新增指令。后续回复不能切换工作目录，换项目请新发邮件。同一会话和同一目录的邮件任务顺序执行，回复旧邮件也追加到会话最新进度。每封回复仍须通过当前规则验证，并来自原发起人；普通 DSH 会话的通知由配置的结果收件人续聊。

`notifications.enabled` 默认 `false`，开启后通知当前实例内其他主会话的每轮结果，子 Agent 不单独发信。`notifications.rule` 可指定复用哪条规则的发信账户、收件人和来源策略，省略时使用第一条规则。`notifications.receipts` 默认 `true`，控制邮件任务入队后的收件确认。所有通知使用持久队列；重启恢复已记录的待发邮件，并核对首次启用全局通知以来的已持久化会话轮次，避免遗漏和重复创建通知。

普通 DSH 会话经邮件续聊时保留原会话的权限和模式。插件不会主动补发首次开启全局通知之前的历史轮次；不同 profile 或独立进程需要分别加载插件。

## 规则与任务

`rules[].account` 选择收信账户，`authorization.policy` 引用来源策略。规则按 `priority` 从高到低匹配，匹配条件同时满足时才接纳任务。

| 字段 | 用途 |
| --- | --- |
| `authorization.allowedSenders` | 允许触发任务的发件地址 |
| `match` | `subjectPrefix`、`subjectContains`、`bodyContains`、`to`、`hasAttachments` |
| `task.agentPreset` | 可选；省略时在每次任务启动时读取 DSH 当前默认 Agent preset，填写时固定使用该预设 |
| `task.permissionPreset` | 默认 `danger-full-access`，完整访问、无需审批；可显式改为其他权限 preset |
| `task.template` | 引用 `templates` 中的任务模板 |
| `task.timeoutMs` / `task.maxSteps` | 默认 15 分钟、40 步 |
| `task.model` | 可选的 `provider`、`model` 和 `maxTokens`；未设置时在任务启动时沿用 DSH 当前模型选择与参数 |
| `task.attachmentTypes` | 允许传给任务的附件类型，默认不传附件 |
| `reply.account` / `reply.to` | 发信账户和固定的结果收件地址 |
| `reply.on` | 默认通知 `succeeded`、`failed`、`cancelled`、`timed_out` 和 `needs_attention` |

邮件里的 `workspace` 优先于可选的 `task.workspacePath` 默认目录。邮件不能改变权限 preset、模型或结果收件人。

模板使用 `{{subject}}`、`{{body}}`、`{{from}}`、`{{workspace}}` 和 `{{attachmentText}}`。正文中的目录配置段会在渲染前移除。文本附件支持 `text/plain`、`text/csv` 和 `application/json`，必须显式列入 `task.attachmentTypes`。

## 容量与并发

常用限制可在 `runtime` 中调整：

| 字段 | 默认值 |
| --- | --- |
| `maxConcurrentTasks` | 2；同一真实工作目录仍串行执行 |
| `maxQueuedTasks` | 100 |
| `maxRecords` | 10000；达到后暂停接纳新邮件 |
| `maxMessageBytes` | 10485760（10 MiB） |
| `maxTaskBytes` / `maxReplyBytes` | 65536（64 KiB） |
| `maxAttachmentBytes` / `maxAttachments` | 5242880（5 MiB）/ 5 |

`maxReplyBytes` 分别限制纯文本与 HTML 正文的 UTF-8 字节数，超出部分会明确标注已缩短。预算不足以容纳 HTML 模板时只发送纯文本。HTML 不加载远程图片；执行时间以 UTC 标注，耗时、模型和步数仅展示实际记录到的值。完整字段、取值范围和默认值见[配置定义](../src/config.ts)。
