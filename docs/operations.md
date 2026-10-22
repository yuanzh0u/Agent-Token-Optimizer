# 安装、运行与回退

此发布仅观察。CLI 不调用 provider、不自动扫描 HOME、不读取生产配置；verify 不构成宿主执行能力证据。核心使用包内相对 ESM 导入；普通 Node 直接导入插件 TS 入口需要宿主 SDK 依赖解析环境。

## 来源与策略

1. 执行 README 的 init，编辑 deployment.json；相对路径以其目录为准。配置仅接受 version/policy/ledger/reportDirectory/sources/staleAfterMs。
2. JSONL 显式映射稳定 sourceRecordKey 和已确认的 cache 包含关系。SQLite 显式配置 table/columns.keys/json 或 zstd，先由部署方生成一致 checkpoint 后的 rollback-journal 快照。collector 不直接打开原库、不执行 checkpoint；WAL/SHM/journal 返回 unsupported 和操作提示。
3. conversationAccess:true 为显式授权；incognito 或访问被拒绝的数据不采集，不使用 transcript/backfill 绕过隐私 gate。宿主 incognito 不派发的文档行为尚未端到端验证。
4. verify --config 验证结构，不打开来源。policy dry-run 预览策略，再 collect/report 查看覆盖、权限、WAL、数据质量。

`examples/deployment.json` 可直接运行，但只有合成来源。features 是声明，不会启用不存在的执行器。完整身份为 agentId/sessionId/runId；名字不决定角色。多个 agent 可绑定同一 profile，binding.runId 可限定运行；重命名同步修改 agentId。pilot map 需人工挑选 bindings 合并，且对应 profile 必须存在，不得整体覆盖通用 policy。

来源默认 64MiB、单条 2MiB。全量复扫，cursor 仅诊断；完整扫描才 reconcile，部分/失败扫描不把未读记录当删除。失败来源保留 coverage reasons；knownTotals 是部分已知值，完整 totals 可为 null。全部失败时 `no-usable-sources` 保留旧 JSON/HTML；独立的 0600 collection-health.json 在读取来源前标 collecting，失败标 failed，只有 JSON/HTML 都发布成功后才标 healthy 并绑定唯一 publicationId。CLI/readReport 在 failed/collecting/缺失/损坏/ID 不匹配时不会返回 fresh，直到成功重新发布；旧版无健康标记的报告也需重新采集。若健康文件无法写入，采集不会开始；掉电落盘保证和并发多写者不在本地原子替换保证内。state 拒绝为 `state-unavailable-or-unsupported-schema`，写入失败为 `ledger-write-failed`。稳定错误码不携带原始内容/异常文本。

目录 0700、账本/报告 0600。ledger 及其保留的 -wal/-shm/-journal、报告 JSON/HTML/collection-health.json、部署/策略文件都不能互相别名或作为来源（包括硬链接/符号链接）；任何受保护文件均不能占用这些 sidecar 名称。每个写进程使用独立账本；SQLite busy_timeout 为 1000ms。崩溃后重扫，缺失/改写隔离旧记录，不自动修复为成功。

每次 collect 都将当前配置来源 ID 集合持久化为 ledger sourceScope（schema v2），跨进程重开仍生效。当前 perSource/groups/global/estimates/quarantined 仅计算 active 来源；inactiveSources/inactiveRecordCount 明示保留的审计范围，cursor 和原记录不删除。重加必须重新扫描，期间追加会计入、改写/删除会照常隔离；active 失败来源保持 coverage degraded，而不是用旧健康值冒充本次成功。来源 scope 是已配置计量边界，globalComplete 不保证所有 provider/宿主请求都被发现。

没有显式 setSourceScope 的 core/插件账本保持 all-observations 诊断模式，llm_output 仍为 attempt 聚合、缺 billing IDs 的不完整观察。collector 显式范围不会自动包含这些插件记录；不得猜测关联或把排除的观察当成完整账单。多个部署不得共用同一可写账本/报告目录；单份 scope 表示此独立账本最近一次显式采集尝试的范围。保存报告中的范围则是该次成功发布的范围。

保存 HTML 标的是 Saved snapshot age 和发布时 coverage；它不读取外部健康文件，不会获知后续采集失败。需要当前采集健康时运行 CLI report，不能把旧 HTML 的年龄阈值当作系统健康。备份/复制本地报告应保留 JSON、HTML、collection-health.json 三件；标记缺失或 publicationId 不匹配会保守显示 stale。

## 隔离宿主加载

根 tgz 包含 root manifest 和 OpenClaw TS 入口；嵌套 private 描述不能单独分发。先将根包解开到 ROOT_PACKAGE，使用实际安装的 HOST_MJS。生成全新配置，不复制生产配置；创建临时 home/state/workspace/cache/tmp，关闭 cron，无 channels。按本机实际路径替换占位符：

```bash
probe=$(mktemp -d /tmp/ato-inspect.XXXXXX)
mkdir -m 700 "$probe/home" "$probe/state" "$probe/workspace" "$probe/cache" "$probe/tmp"
# 把下方配置写到 "$probe/config.json"，替换 ROOT_PACKAGE、PROBE_WORKSPACE
cd "$probe"
env -i PATH="$PATH" XDG_CACHE_HOME="$probe/cache" TMPDIR="$probe/tmp" \
  OPENCLAW_HOME="$probe/home" OPENCLAW_STATE_DIR="$probe/state" \
  OPENCLAW_CONFIG_PATH="$probe/config.json" OPENCLAW_WORKSPACE_DIR="$probe/workspace" \
  node "$HOST_MJS" plugins inspect openclaw-token-governor --runtime --json
```

```json
{
  "agents": {"defaults": {"workspace": "PROBE_WORKSPACE"}},
  "cron": {"enabled": false},
  "plugins": {
    "allow": ["openclaw-token-governor"],
    "load": {"paths": ["ROOT_PACKAGE"]},
    "slots": {"memory": "none"},
    "entries": {"openclaw-token-governor": {
      "enabled": true,
      "hooks": {"allowConversationAccess": true},
      "config": {"conversationAccess": true, "queueCapacity": 128}
    }}
  }
}
```

检查 plugin.status:loaded、imported:true、requiredInstalled、typedHooks、diagnostics；退出 0 不够。本次 2026.10.3 的 hook-only compatibility 是支持但未显式注册 capability 的提示。inspect 使用 tool-discovery，services 空是预期；inventory activated 不证明 service start、收到事件或执行 gate。实际生产部署需人工按 fragment 逐项合并，保留所有原 allow 成员与 contextEngine。本次没有做生产安装。

完整模式服务在宿主 stateDir/token-governor/usage.sqlite 中写局部观察；队列默认 128、最多 1024，单批同步写入。hook 只投影和排队，按需 setImmediate 刷新，无周期任务/LLM 心跳。stop 先关闭接收再刷新已接收队列；signal/onDispose 退休直接丢弃旧代队列并停止写入。突然杀进程、队列满、非法计数、写盘失败会丢观察；已持久化缺口标 degraded，来不及持久化的内存缺口无法量化。不得作为完整计费来源。

SDK llm_output 没有稳定 billing account/request ID，ctx.accountId 属于 channel；不猜测关联 model-call hook。model 已在白名单，未另加不含 usage 的 model_call 事件。完整计费仍需可信 provider 适配器覆盖 primary/retry/summary/retrieval/fallback。

## 升级、回退与证据

升级前停止采集/观察器，等在途结束或记录取消；一致备份独立账本、原包、版本锁和私有补丁 receipt，不覆盖 native transcript。已知 v0/v1→v2 仅接受原来的完整精确 records/sources 结构；事务内新增 collection_scope 表并写 application_id/user_version，不改历史记录。新库为 v2，旧代码不得就地降级读取；未指定 scope 的已迁移数据保持 all-observations，首次成功 collector 发布会明确设置范围。所有权预检先检查 sidecar/WAL 文件头，再用 64KiB 流式双读一致校验，把内容写入已取消文件名的私有 SQLite inode，只在匿名副本查询完整 schema；预检不会让 SQLite 打开原路径。批准后在可写边界再次检查原文件版本和 sidecar/schema。发现任何 journal/WAL/SHM（含冷文件或断链符号链接）或 WAL 文件头都拒绝自动恢复，包括项目自己的中断状态；先一致保全 main+sidecars，在隔离可信副本中恢复/验证，再提供无 sidecar 的 rollback-journal 状态，不可删除日志后强行重试。状态必须由独立单写者持有；这些文件一致性检查不是对同用户恶意竞态的 OS 级排他锁。未知/较新 schema 拒绝初始化；旧程序从升级前备份另建 state，不能在线降级改写新库。迁移/拒绝写回归已测，迁移中断/实际磁盘满矩阵 pending。

用 core fingerprint/planPatch/rollbackPatch 维护自己的最小配置补丁；receipt 含敏感原值，0600、不公开。rollback 仅恢复自己拥有且仍等于 patched 值的键，保留之后独立修改；owned-key 冲突需人工处理。测试覆盖引擎未设置/legacy/custom、后续修改、父对象删除；不强制 legacy，不整份恢复配置/数据库，也不声称禁用候选就能恢复已压缩历史。

能力证据必须精确匹配 hostVersion/runtime/provider/workClass；升级或改范围需重跑。版本锁的 host 是实际本机观察，非未来兼容承诺；项目源哈希与实际 npm pack SRI 分开。改源码后需重新审核并更新 projectSourceSha256，重跑 verify。候选 exact archive metadata 来自保留的 candidate-packages 证据，不代表生产安装。

真实模型实验需可信完整请求路由和测试预算：固定 workload/model/thinking/cache，每层 5 对筛查、至少 20 对验证及未调参留出，纳入失败/重试/摘要/检索/重读/缓存重建。CLI evaluate 默认不认证 JSON，fixture verifier 返回 true 不能成为真实测量；测试控制器只是估算预算，不能保证无视 abort 的 provider 或未路由请求的账单上限。

Tokenjuice 原始结果恢复尚未满足采用条件；Lossless 只有带精确依赖的隔离加载证据，生命周期/摘要计费待测；均暂缓。24h/72h soak、历史路线 48h 真实触发、资源开销、真实 heldout、生产门限都 pending，见 coverage.md。没有用定时任务伪造观察时长。
