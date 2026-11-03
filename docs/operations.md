# 故障处理

先在 DSH 会话中运行 `/mail-status`，查看账户健康状态、收件决定、任务状态和通知状态。

## 管理命令

| 命令 | 用途 |
| --- | --- |
| `/mail-dry-run <account> <absolute .eml path>` | 预览真实原始邮件的认证、规则、目录和任务提示，不创建任务或发信 |
| `/mail-cancel <task-id>` | 请求取消运行中的任务 |
| `/mail-release-reply <mail-id>` | 重新验证暂存的回复，作为独立任务执行 |
| `/mail-retry-notification <task-id>` | 重试发送失败的通知，不重新执行任务 |
| `/mail-retry-notification <task-id> acknowledge-duplicate` | 确认可能重复发送后，重试发送结果未知的通知 |
| `/mail-retry-task <task-id> acknowledge-side-effects` | 确认可能重复产生副作用后，创建新任务和新会话 |

## 没有创建任务

| 状态或现象 | 检查方法 |
| --- | --- |
| 账户不健康 | 检查服务器、端口、TLS、凭据名称，以及授权码是否允许 IMAP/SMTP 登录 |
| 启动前的邮件未执行 | 默认只接收首次建立游标后的新邮件，发送一封新邮件验证 |
| 邮件进入 `quarantined` | 检查发件地址、来源验证、规则、邮件年龄和 `workspace`；用 `mail-dry-run` 查看原因 |
| 回复进入 `held` | 回复默认暂存；需要执行时使用 `mail-release-reply` |
| 文件夹报告 `uidvalidity-changed-review-required` | 邮箱中的 UID 身份已变化；核对邮箱与原有任务记录后再处理，不要直接删除游标 |
| 队列或记录达到上限 | 检查积压任务和 `runtime` 限制；去重记录不自动清理，删除会改变防重复行为 |

## 没有收到结果邮件

任务状态和通知状态分别记录。检查规则的 `reply.on`、发信账户、固定收件地址，以及 SMTP 是否正常。

- `accepted`：SMTP 服务器已接受提交；仍需检查收件箱、垃圾邮件或服务商投递记录。
- `failed`：确认提交失败，可用 `mail-retry-notification` 重试。
- `unknown`：可能已经提交成功，但确认丢失；先核对邮箱，再决定是否接受重复发送风险。

结果只包含最后一条已记录的 Agent 文字。正常结束却没有文字或结构化结果时，任务标为 `needs_attention`；取消或超时会保留已有文字。完整执行过程请打开对应 DSH 会话。

## 重启与维护

重新启动会继续发送已持久化的待发通知。中断时仍在执行的任务变为 `needs_attention`，正在发送的通知变为 `unknown`，不会自动重放工具操作或重复发信。核对原会话和实际结果后，再决定是否重试。

修改排队任务引用的规则、来源策略或收件地址，可能使旧任务停止并等待核对。暂停插件可将 `mail-automation` 行设为 `disabled: true` 后重启。

任务、游标与通知保存在 DSH profile 的存储后端，原始邮件保存在 `stateDirectory/raw`。备份时同时保留 profile 数据和该目录；不要让多个 DSH 实例通过不同数据目录操作同一份邮件任务记录。
