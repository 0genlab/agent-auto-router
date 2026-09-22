# agent-auto-router

评测各模型在**同一个 agent** 下的真实表现：效果、成本、token 经济学。
所有结论可复现：agent 版本钉死、任务客观打分、逐轮请求/响应全量落盘、直连官方端点自费运行。

## 核心资产

1. **逐轮原始数据**（`data/runs/`）——agent × 模型的每一轮请求/响应、SSE chunk 级时间戳。榜单和文章都是从它派生的视图。规格见 [schema/SCHEMA.md](schema/SCHEMA.md)。
2. **每 agent 接入档案**（`agents/<name>/`）——安装、每模型配置方法、踩坑记录。面向开发者的可查阅参考。
3. **任务集**（`tasks/`）——见 [tasks/TASKS.md](tasks/TASKS.md)。目标形态=1 旗舰 + 5 探针 + agent 特色实验；**episode 1 实际已建成并跑过 2 个**：`ep1-f005`（旗舰：真实凭据泄漏安全修复，即我们上游的 F-005）+ `p1`（探针：工具链寻宝追踪）。二者都不是刷题，是 agent 用终端工具做真实开发/操作任务。

## 组件

- `relay/` —— 本地记录代理：忠实转发 + 逐轮落盘 + 写入时脱敏。所有 agent 共用。
  启动：`node relay/relay.mjs`（127.0.0.1:8484）；控制面 `/_run/start` `/_run/stop` `/_health`。
- `scripts/` —— harness 与分析脚本（duckdb 直查 turns.jsonl）。
- 第一期对象：Hermes Agent（OpenRouter 全球榜 #1），档案在 `agents/hermes/`。

## 角色模型策略实验层

`configs/role-policy.json` 和 `scripts/role-run.mjs` 提供一个 additive 的多 Agent 角色评测层：

- 角色：`planner`、`researcher`、`explorer`、`implementer`、`e2e`、`reviewer`；
- 记录：任务、角色、模型、测试、返工、耗时、token、成本和证据；
- 评测：核心只使用测试、E2E、diff、回归、耗时、token、成本和人工验收等可追溯证据；LLM Judge 不进入默认评分链路；
- 策略：默认 `shadow`，先统计和推荐，满足样本、质量、成功率和成本门槛后再考虑灰度/晋级；
- 兼容：不修改现有 `data/runs/` 和 `data/scoreboard.jsonl` 的语义。

### 通用核心与适配器边界

当前项目以 `0genlab` 为评测实验室，仓库名称为 `agent-auto-router`；当前版本先提供可复用的角色模型评测与策略层，不把 Codex 误包装成只能服务于某个 Agent 的运行时网关。角色模型策略已经拆成两层：

- `src/core/role-policy.mjs`：纯策略核心，负责客观指标、候选门槛、基准模型比较和自动晋升判断，不依赖 Codex 或具体存储。
- `src/core/contracts.mjs`：定义 Agent、模型目录和任务评测适配器契约，并统一任务画像字段。
- `adapters/jsonl/role-run-store.mjs`：JSONL 文件存储适配器。
- `adapters/codex/role-run.mjs`：Codex CLI 角色运行适配器，保留 `scripts/role-run.mjs` 作为兼容入口。
- `adapters/aihubmix/model-catalog.mjs`：AIHubMix 实时 LLM 目录适配器，核心只依赖 `ModelCatalogProvider` 契约。
- 推荐结果包含质量、成功率、成本、P95 延迟、回归和返工维度的 `pareto_frontier`，避免只按最低成本选模型。

后续接入其他 Agent 时，只需新增 Agent adapter 和对应的模型目录 provider；不要把 Codex 的 `AGENTS.md`、subagent 配置或 AIHubMix 启动脚本复制进核心层。仓库名称固定为 `agent-auto-router`，但核心仍保持 Agent 无关，在线请求转发由具体宿主适配器负责。

示例：

```bash
RUN_ID="$(node scripts/role-run.mjs start --title "实现退款重试" --type implementation --expected "测试通过")"
node scripts/role-run.mjs record --run-id "$RUN_ID" --role implementer \
  --model deepseek-v4.1-flash --status success --quality-score 4.2 \
  --tests-run 8 --tests-passed 8 --rework-count 0
node scripts/role-run.mjs recommend
```

### 自动记录一次 Codex 命令

不要把 0genlab 强行写进全局 Codex 启动器；需要记录时显式使用适配器：

```bash
ROLEBENCH_ROOT=/path/to/0genlab node scripts/codex-run.mjs \
  --role implementer --model deepseek-v4.1-flash \
  --title "实现退款重试" --type implementation \
  --task-family implementation --repo-language go \
  --tool-profile terminal+tests -- \
  codex exec --full-auto "实现退款重试并运行测试"
```

命令退出后自动写入 `agent_finished` 事件和耗时；测试结果、成本、质量分和证据仍由任务验证步骤补录。失败时保留失败状态，不把退出码伪装成模型质量评分。

随后运行客观评测器：

```bash
ROLEBENCH_ROOT=/path/to/0genlab node scripts/evaluate-run.mjs \
  --run-id "$RUN_ID" --project /path/to/project \
  --test-command '["npm","test"]' \
  --regression-command '["python3","regression_test.py"]'
```

评测器只写结构化结果，不写入测试命令的 stdout/stderr。

若 Agent 能生成 usage 文件，可以同时记录 Token 和成本：

```bash
ROLEBENCH_ROOT=/path/to/0genlab node scripts/codex-run.mjs \
  --role implementer --model deepseek-v4.1-flash \
  --title "实现退款重试" \
  --usage-file /tmp/codex-usage.json \
  --input-price-per-million 0.5 \
  --output-price-per-million 2 \
  -- codex exec "实现退款重试"
```

没有可信 usage 或没有同时提供输入/输出单价时，成本保持为空，不会猜测。

也可以从 AIHubMix 实时模型目录生成价格快照，`codex-run` 会自动读取它：

```bash
ROLEBENCH_ROOT=/path/to/0genlab node scripts/sync-model-prices.mjs
```

快照默认写入 `data/model-price-snapshot.json`，包含模型 ID、输入/输出单价、币种、来源和抓取时间。每次价格更新后重新执行同步命令即可。

### 批量对照实验

使用任务文件把同一个角色任务运行到多个模型：

```bash
ROLEBENCH_ROOT=/path/to/0genlab node scripts/run-role-experiment.mjs \
  --task schema/role-experiment.example.json \
  --role implementer \
  --models deepseek-v4.1-flash,deepseek-v4-pro
```

任务格式见 `schema/ROLE_EXPERIMENTS.md`。每个模型独立记录和评测，结果写入 `data/experiments/`；这个命令只生成对比报告，不会自动修改角色配置。

生成实验摘要：

```bash
node scripts/summarize-experiment.mjs \
  --report data/experiments/role-implementer-implementation-001.json
```

摘要会明确显示 `insufficient_evidence` 或 `candidate`，不会因为某个模型便宜就直接推荐。

多个任务的报告可以合并：

```bash
node scripts/summarize-experiment.mjs \
  --reports-dir data/experiments \
  --output data/experiments/implementer-summary.json
```

候选门槛按不同 `task_id` 统计，不会把同一个任务的重复运行误算成任务多样性。

### 真实 Codex 会话后台记录

不需要构造实验任务，可以直接导入本机已有 Codex session JSONL：

```bash
ROLEBENCH_ROOT=/path/to/0genlab node scripts/ingest-codex-sessions.mjs
```

采集器只记录 session 元数据、角色、模型、耗时、Token 和成本，不复制 Prompt、响应、工具输出或源码；同一个 session ID 重复执行不会重复入账。

## 红线

- 密钥只走环境变量，写入时脱敏（见 SCHEMA 原则 1）。
- 不使用任何公司内部数据；全部数据自费走公开官方端点。
- 派生指标只准脚本重算，禁止手改。
