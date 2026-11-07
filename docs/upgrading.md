# 升级到 0.2

0.2 会自动将插件数据从 v1 升级到 v2，DSH 和 Node.js 的支持范围不变。

1. 停止加载该插件的 DSH 实例。
2. 一起备份 profile 的存储后端和 `stateDirectory`；原始邮件位于其中的 `raw` 目录。
3. 更新源码，运行 `bun install --frozen-lockfile`、`bun run build`，然后重新启动 DSH。

升级保留收件去重标识、任务编号、DSH 会话、邮件引用、原始邮件和已生成的待发正文。普通任务与会话通知使用不同记录类型，IMAP、POP3 游标和通知观察时间分别保存。

升级中断后，下次启动会继续迁移。遇到无效或冲突数据时会停止启动并报告错误，不会重置游标。待发邮件继续发送；发送结果不明的邮件不会自动重发。执行中任务的恢复与核对方式见[故障处理](operations.md#重启与维护)。

旧版本不能读取已升级的 v2 存储。需要回退时，先停止 DSH，再同时恢复旧代码及升级前备份的存储和原始邮件目录；仅回退代码不能恢复旧数据格式。

通过 `/core` 嵌入时，收信适配器需提供稳定的 `Delivery.id`。`MailStore` 的任务访问接口改为 `getRecord`、`records`、`recordCount`、`putRecord` 和 `updateRecord`；邮箱游标使用 `kind` 区分协议，通知观察时间通过独立的 `notificationState` 接口访问。自定义执行器只接收 `kind: task`，其 `mode` 为 `new` 或 `followup`。
