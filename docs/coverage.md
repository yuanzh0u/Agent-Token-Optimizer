# v5 实际覆盖矩阵

状态截至 2026-10-21；基线为实际 Node v24.21.0 / OpenClaw 2026.10.3。`offline partial` 仅证明列出的本地断言，`host verified (局部)` 仅证明对应精确宿主路径，`pending` 缺少实际运行证据，`unsupported` 为本发布未实现。下面没有整项端到端通过或 v5 上线声明。公共范围见 docs/scope.md；原始私有规划与试点档案不随公开仓库分发。

## R01–R14

| 要求 | 实际状态 | 文件 / 已验证断言 | 缺口 |
|---|---|---|---|
| R01 保留原试点和监控 | offline partial | 通用初始化无试点依赖；原试点只读哈希检查记录保留在私有开发档案，不公开本机配置 | 生产持续行为未冻结或迁移 |
| R02 多维用量与缺口 | offline partial | usage/ledger/report 模块；tests/integration.test.mjs 的 model 分组、跨 CLI 持久失败 stale、活动来源 scope/历史审计隔离、缺口非零 | hook 不完整覆盖付费请求，真实 source adapter 待测 |
| R03 原生循环检测 | host verified (局部) | evidence/native-host-loop-run.json：固定只读 exec 在 local fake provider 下终止；replay 测试 | 语义变体/合法重试/跨压缩边界 pending |
| R04 单输出压缩器与保真 | offline partial | experiment-contracts；token-efficiency-contracts.test.mjs 的原结果回退/恢复引用；output-candidate-probe.json | Tokenjuice 未满足原始结果恢复，暂缓采用 |
| R05 单历史引擎 | offline partial | validateHistoryContract；history lifecycle fixture 保持选择、工具配对、要求/引用 | Lossless 实际摘要/检索/重启 pending |
| R06 pruning 与缓存净收益 | pending | usage 四维和 evaluate 算术支持分账 | 实际模型路由/pruning 触发与净收益未验证 |
| R07 心跳/复盘开销 | pending | 测试控制器区分 summary/retrieval/fallback；不改现有心跳 | 宿主后台请求归因不完整 |
| R08 分级预算能力 | offline partial / unsupported | policy/capabilities exact scope；controller 估算预算和取消回归 | L1/L2/L3 宿主 gate、硬计费 cap unsupported |
| R09 薄插件不占引擎槽 | host verified (局部) | governor-host-inspect.json：loaded/imported、contextEngineIds=[]；完整模式 fixture 服务 | 实际 gateway 生命周期 pending |
| R10 版本、迁移、回退 | offline partial | version-lock；integration 外来/新 schema 拒绝、精确 v0 升级；drift rollback 保留后续编辑 | 跨宿主版本、迁移中断、真实历史恢复 pending |
| R11 本地最小化/隐私 | offline partial + host verified (局部) | report 转义、默认拒绝、队列不存内容；宿主 grant/deny inspect；discovery privacy/SIGKILL 回归 | incognito 实际派发与真实遥测审计 pending |
| R12 配对质量与成本 | offline partial | evaluate tests：synthetic 禁收益、可信证据、失败开销、P95/质量门槛 | 真实 5/20 对、独立 heldout、定价证据 pending |
| R13 通用安装 | offline partial + host verified (加载) | portability.test.mjs fresh npm tarball 十项操作；随机 agent；独立 host inspect | 第二独立实例实际 workload/留出 pending |
| R14 通用策略隔离 | offline partial | policy-usage.test.mjs 继承/来源/冲突/权限/改名；CLI dry-run | 实际 host 多 run 并发策略执行 pending |

## T01–T28

| 场景 | 实际状态 | 文件 / 断言或保留证据 | 尚未证明 |
|---|---|---|---|
| T01 基线/漂移 | offline partial | tests/drift.test.mjs：指纹、owned keys、后续编辑；私有试点指纹不公开 | 实际并发生产写配置回退 |
| T02 黄金账本 | offline partial | tests/policy-usage.test.mjs、ledger.test.mjs：cache 语义/unknown/四维 | 真实 provider 对账 |
| T03 多源去重 | offline partial | ledger.test.mjs：共享 ID 去重/冲突隔离/缺 ID 独立桶 | hook 无账单 ID，不能全局完整 |
| T04 改写/迟到/重置 | offline partial | discovery/ledger tests：复扫、记录删除/改写隔离；collection-state 移除/停用期间变化/跨 reopen 重加；integration 不完整不 reconcile | 原生跨表/压缩 DB schema |
| T05 来源/隐私 | offline partial + host verified (grant) | discovery.test.mjs incognito/access、WAL unsupported、匿名 SQLite；governor deny inspect | 宿主 incognito 实际派发/生产权限 |
| T06 原生简单循环 | host verified (局部) | native-host-loop-run：只读固定 exec、fake provider；不是节省测量 | 其它工具、真实模型、一般恢复成功 |
| T07 语义变体盲区 | offline partial | replay fixtures、native-detector-probe 仅函数级；不执行 side effect | 宿主真实语义/跨工具终止 |
| T08 合法重试/写操作 | offline partial | token-efficiency-replay.test.mjs：不执行 fixture side effects、时间/进展 | 真实 host 合法调用误阻断率 |
| T09 跨边界循环 | offline partial | replay session/run 隔离 | compaction/restart/下一回合真实保护 |
| T10 输出保真 | offline partial | token-efficiency-contracts.test.mjs：exit/facts/recovery 原文回退；候选局部 probe | Tokenjuice 全 fidelity/原始恢复 |
| T11 工具/运行时边界 | offline partial | contracts shell-only；read/exact/JS/Code Mode 旁路 | 真实 middleware 路由覆盖 |
| T12 压缩故障/超时 | offline partial | contracts：异常/timeout/schema fallback，执行一次 | 实际候选同步阻塞、宿主 timeout |
| T13 长历史/检索 | offline partial | lifecycle fixture、当前要求/引用/工具配对检查 | Lossless 实际检索、事实质量 |
| T14 历史生命周期 | offline partial | evaluateHistoryLifecycle contract-only | 真正重启/故障/压缩/迁移 |
| T15 单所有权 | offline partial + host verified (加载) | contract 单 owner；governor 无 engine，Lossless 已有 inspect 证据 | 多组件真实组合不重复压缩 |
| T16 pruning/净收益 | pending | 四维计量/评估器可承载证据 | 实际触发、cache 失效/summary/retrieval 成本 |
| T17 技能/上下文 | pending（仅静态基线） | 原试点静态基线保留在私有开发档案；公共快照不含 Agent 映射或本机配置 | 工作负载技能质量回归 |
| T18 后台开销 | offline partial | controller purpose 包含 summary/retrieval/fallback | heartbeat/cron/复盘真实请求归因 |
| T19 预算入口/gate | unsupported（宿主） | policy dry-run 保持 observe；exact capability gate | L1/L2/真实 host 入口阻断 |
| T20 控制器限额 | offline partial | token-efficiency-controller.test.mjs：原子预约/流/取消/晚结算/不合作 provider | 全宿主请求路由、provider 真正输出上限、硬账单 cap |
| T21 升级迁移 | offline partial | integration/collection-state 外来/新 schema 字节不变、精确 v0/v1→v2 scope 升级；ledger-safety 热 journal/WAL/冷 sidecar 不恢复不改字节；capabilities host scope 不匹配失效 | 新宿主矩阵、迁移中断/备份恢复 |
| T22 回退后会话 | offline partial | drift 引擎 unset/legacy/custom、后续键保留、owned conflict 拒绝 | 真实会话恢复/候选历史导出 |
| T23 配对收益 | offline partial（算术） | evaluate：synthetic/trust/quality/P95/failed/pairs/heldout | 真实每层 5/20 对，独立留出，无收益率声明 |
| T24 24–72h soak | pending | readReport 新鲜度、collector 全失败后独立 CLI stale/2、恢复清除和 collecting/未知健康标记回归 | 真实 24h/72h，历史机制至少 48h，CPU/RSS/跨日恢复 |
| T25 最小化报告 | offline partial | report/CLI/integration 内容哨兵、权限、HTML escaping、health 文件无内容/受保护别名、无网络实现；ledger-safety 39 组保留 sidecar 别名拒绝 | 实际宿主/候选外联审计 |
| T26 故障不拖住 host | offline partial | integration 有界 callback/queue、DB 锁失败恢复、stop/restart、abort、旧代停写 | 真实 gateway stop/reload、磁盘满、gate timeout |
| T27 通用安装 | offline partial + host verified (加载) | portability fresh pack/extract、core/全 CLI/demo、随机 ID；独立状态 host inspect | 另一真实实例 heldout workload |
| T28 策略组合隔离 | offline partial | policy-usage 继承/冲突/run/权限/命名、CLI 预览 | 已启用 host 执行器的并发切换 |

## 发布前剩余证据

真实模型请求在此实现中为 0。当前无已认证 provider-measured pair，CLI JSON 不能自行认证，所以不能宣称 40% 或其它节省率。候选 adoption 均 deferred/pending，不下载、修复依赖或启用新候选；Tokenjuice 缺原文恢复，Lossless 缺真实历史/摘要/检索证据。没有创建 recurring job 或改生产默认模型/引擎。

host inspect 的 services=[] 和局部 fixture 服务测试不能相互拼成实际宿主启动证据；incognito、reload/retirement、完整失败/重试计费仍需有界真实 host 探针。24–72h 尚未实际经过，必须保留 pending。版本/源码锁仅确认已读文件，未来版本不得继承本次能力标签。
