# 群通知

通知模块提供持久事件登记、QQ群目标与事件开关、消息预览、发送测试及投递处理。平台通过 OneBot v11 HTTP 主动调用 NapCat 等兼容实现，机器人继续由部署者管理；无需为了发通知再启动一个机器人框架。

当前交付为独立基础模块。工作台、作品及其他业务服务尚未调用事件登记入口，因此开启配置不会自动推送现有作品变化，也不会扫描历史审计补发。已有 WorkEventAction 是作品事件目录的来源，后续可在明确业务事务边界后接入。

## 配置连接

默认关闭通知，不运行通知维护/消费循环，不请求机器人。API 和 worker 使用相同的私有配置；配置文件放在仓库和镜像构建上下文之外。

```dotenv
NOTIFICATIONS_ENABLED=true
NOTIFICATION_CONNECTIONS_FILE=/absolute/private/notification-connections.json
COMIKU_QQ_BOT_TOKEN=replace-in-private-environment
```

文件支持连接数组或 `{ "connections": [...] }`，最多 8 个连接、64 KiB。示例只包含占位地址和环境变量名称，不要在公开文件中填实际凭据。

```json
{
  "connections": [
    {
      "key": "team-qq",
      "name": "团队机器人",
      "adapter": "onebot-http",
      "endpoint": "http://127.0.0.1:3001",
      "tokenEnv": "COMIKU_QQ_BOT_TOKEN",
      "allowedIps": ["127.0.0.1"]
    }
  ]
}
```

连接文件只能由部署者维护，网页不接受任意 endpoint、headers、token 或 action。API 只返回连接名称和是否可用，不回显 URL、密钥或内部指纹。坏文件或某连接配置错误会使通知不可用，不触发机器人探测，也不会把私密解析错误传给业务接口。

HTTP 只允许显式许可的 loopback/私网地址；公网连接使用 HTTPS。DNS 返回的所有地址都必须在精确 allowedIps 内；请求固定连接经过验证的地址，不跟随重定向、不继承环境代理。metadata、链路本地、多播和未指定地址始终拒绝，HTTPS 使用正常证书验证。总超时 5 秒、响应最多 64 KiB，连接池随应用关闭释放。

连接配置按进程启动时读取。换 endpoint、token 或允许 IP 后，重启通知相关 API/worker 以采用新配置，再在系统管理中重新保存对应群目标，确认新的连接代次。旧投递不会自动改用新连接。先停用目标并等待在途请求结束，可使轮换边界更清晰；未确认的在途发送按未知结果处理。

## 系统管理

只有当前具有 system:manage 的用户可以读取通知配置和投递记录，或执行新增、修改、测试、核对及补发。每个群目标选择一个连接，并配置群号、事件开关和是否包含作者/标题/操作人昵称。保存配置不发送消息；“发送测试”是独立操作，返回排队不等于群内已收到。

默认消息包含编号、动作、发生时间及需要登录的站内详情链接。额外内容使用固定白名单；不会把审核理由、内部备注、授权凭证、原图、签名 URL 或任意 WorkEvent.detail 发到群里。用户文字编码为 OneBot text 段，文字中的 CQ 码不会触发图片或 @全体。

停用、改群及更改事件策略会推进配置版本，旧待发记录取消并保留原因；重新启用只接收之后登记时匹配的事件，不倒灌历史。全局运行开关关闭则暂停后台处理并保留既有待办。已通过发送边界的在途请求仍可能完成，关闭开关无法召回已在网络中的消息。

原样保存不会生成新投递策略，仅修改群目标的显示名也不会取消待办。管理页面使用的 revision 与后台投递代次承担不同职责：前者防止多人覆盖编辑，后者控制是否允许继续向原受众发送。

## 事件登记接口

模块导出 NotificationPublisherService，供后续业务服务通过公开接口接入，不依赖机器人协议或群号。没有任意发布业务事件的管理 HTTP 端点。

```ts
await publisher.recordTx(tx, {
  eventKey: `work-event:${sourceEventId}`,
  type: "stage_submitted",
  resourceId: workId,
  aggregateVersion: savedWorkRevision,
  ordinal: 0,
  occurredAt: occurredAt,
  workNumber: workNumber,
  stage: "translate",
  fromWorkflowStatus: "translating",
  toWorkflowStatus: "pending_proofread",
});
```

recordTx 只执行数据库查询和登记，可与业务提交原子保存；失败向调用方返回，不静默漏记。它保存登记时生效的群订阅与原目标快照，异步路由不按后来的群配置改写历史。相同 eventKey 与相同归一化数据返回原事件；同 key 的不同内容冲突。不要在业务重试时换新 key 或重新生成发生时间。

record(event) 在独立事务中登记，并对可重试的数据库事务冲突作有限重试。它不保证与之前另一个业务事务原子；业务已提交、进程在调用 record 前退出仍会漏事件。需要可靠关联时应使用 recordTx，或另行设计具备持久来源的补账流程，不能用 fire-and-forget 或扫描时间游标替代。

当前事件目录包括入库、认领/退出、页码分工、阶段提交/取消、免校、审核申请/撤回/恢复、归档/恢复和发布确认。类型复用生成的 WorkEventAction；自动保存、逐图识别和作者变化尚未接入。调用方提供聚合版本与事务内 ordinal；同群同资源按已登记顺序处理，不承诺任意延迟外部登记仍能恢复全局因果顺序。

## 投递与故障恢复

后台使用既有 JobsService 的 network/notifications scope，独立于采集与图片处理槽。事件、投递和尝试是持久记录，Jobs 拥有执行租约；通知模块不另建一套租约引擎。短事务预约发送，提交后调用网络，再用条件写保存回执；网络期间不持业务或投递行锁。

| 状态       | 含义                                                      |
| ---------- | --------------------------------------------------------- |
| pending    | 已登记，等待执行                                          |
| sending    | 已跨越发送预约边界，外部请求可能发生                      |
| retry_wait | 已确定未发送的暂时故障，等待有限重试                      |
| accepted   | 协议返回成功且保存 message_id；不代表所有群成员收到或已读 |
| failed     | 永久拒绝或安全重试次数耗尽，记录保留待处理                |
| unknown    | 超时、断线、异步响应或发送后崩溃等，无法确认结果          |
| cancelled  | 用户停用/改群、权限或配置代次改变，未继续发送             |

同一业务 key、重复路由和多 worker 竞争不会重复建立普通投递。可确认尚未发出的暂时故障有限自动重试；unknown 不自动再发。已有 Job 第三次租约耗尽后可能不再进入 handler，因此维护循环还会有界对账，把遗留 sending 收敛为 unknown。

未知结果只隔离同群同资源的后续投递，其他作品继续。管理员可以标记已核对，或在明确接受可能重复后创建历史补发；原记录和尝试保留，补发操作有独立幂等 key。测试与人工补发发送前重新检查发起人资格；团队业务通知不依赖旧配置人始终在职。

未决事件和投递不会因时间自动过期或清理。故障后应查看投递记录，处理 failed/unknown 或明确取消。当前不提供历史正文自动清理或摘要合并；规模增长后需增加安全保留/归档策略，不能删除去重证据后重新发送旧事件。

OneBot 标准不提供客户端发送幂等键。站内持久意图可以防丢记、防重复排队，但不能在远端已发、回执丢失时同时严格保证群内恰好收到一次。echo 只是请求关联标识。HTTP 200 仍需检查 status/retcode/message_id；async 不作为成功回执。参见 [v11 HTTP](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)、[消息 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。

## 验证与扩展

普通测试只使用合成事件和本机协议替身，不访问真实群。数据库测试要求独立 _test 数据库；迁移是追加式，并验证重复部署与无漂移。真实机器人验证应使用专用测试群，分别核对入队、协议回执和群内可见消息。

后台批量有界，外发串行、按群持久限流，关闭时不轮询通知。当前少数群无需 Redis、额外 Python 或完整机器人框架。适配器契约保留独立事件与传输结果，后续可实现 OneBot v12/其他平台、个人身份与 @、批次摘要或催办；每项需单独实现并验收，不在 UI 暴露未实现的平台入口。
