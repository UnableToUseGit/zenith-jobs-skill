---
name: zenith-jobs
description: 向 Zenith 平台（zenith.bza.edu.cn）提交、监控、取消 GPU 训练任务。用于跑训练/批处理、查任务状态与日志、排查失败，或把实验丢到平台排队等空卡。
---

# Zenith 训练任务

客户端 `scripts/zn.mjs`（零依赖，Node ≥ 20）：`ZN="node scripts/zn.mjs"`。

## 凭据

Token 只放 `$ZENITH_API_TOKEN` 或 `~/.zenith/token`（0600）。别打印、别写进 entrypoint / 仓库 / `.env`。

必需 scope：`jobs:create` `jobs:read` `jobs:cancel` `operations:read` `catalog:read`；建议加 `profile:read` `projects:read`。

401（退出码 3）或缺 scope（403，响应里 `required_scopes` 指明缺哪个）→ 停下来让用户自己建，API 不能代办：

> 平台右上头像 → **账号设置 → API Token → 新建**。名称写用途，有效期默认 90 天（最长 365，每人最多 10 个），权限勾上面几项。明文只显示一次。落盘：
> ```bash
> mkdir -p ~/.zenith && chmod 700 ~/.zenith
> read -rsp "token: " T && printf '%s' "$T" > ~/.zenith/token && unset T
> chmod 600 ~/.zenith/token
> ```

已有 token 缺权限：在原记录点「调整权限」，不用新建（已有 token 不会自动获得新范围）。

## 命令

```
$ZN caps | whoami | quota | hours | projects      身份、配额、卡时
$ZN offerings [--project-id ID] [--full]          规格：id / GPU / 单价 / 各区能力
$ZN images <offering> [--workload JOB|DEV_INSTANCE] [--resource-zone Z] [--q KW] [--page-size N] [--all]
$ZN zones <offering> [--workload-type job] [--execution-class C]        各区余量 / worker / 准入
$ZN admission <offering> --workload-type job --resource-zone Z [--project-id ID]
$ZN job-create <offering> --name N --entrypoint "CMD" --intent K
      [--project-id ID] [--image-id ID] [--resource-zone Z]
      [--execution-class standard|low_priority] [--funding-mode MODE] [--replicas N] [--wait SEC]
$ZN jobs | job <id> | logs <id> [--lines N] [--worker W]
$ZN replicas <id> | metrics <id> [--minutes N]
$ZN job-cancel <id> --intent K | op <operation-id>
```

## 易错点

- 提交是 `POST /pt/api2/compute-offerings/{id}/jobs`（开发机在 `/instances`）；`GET /ai/jobs` 只能读。
- `202` 只代表受理。`PENDING` 实测 3.5 分钟，忙时更久；夜里提交别加 `--wait`。
- `--intent` = 幂等键：同 intent 同参数重发＝恢复原操作，改参数本地直接拒（退出码 5）。**超时后必须原 intent 原参数重发**，换 key 就是再提交一份、两份同时扣卡时。
- 预检字段是 `workload_type`（`job`/`instance`），不是 `workload`；预检不锁卡。
- **资源区别写死**，用 `$ZN zones <offering> --workload-type job` 看各区事实再选：`supported:false` / `no_route` 是这区根本不接这类负载（如 ctyun 区只收开发机），别浪费次数去预检；`worker_status:offline` 时余额再大也开不了工；比 `free_gpus`（此刻真空闲）而不是 `available_gpus`（队列口径，可能虚高）；`queue_state` 停用、`capacity_status:unknown` 或样本过旧都不能当“有货”；`retryable:false` 说明等没用，该改参数或换区。所有区都 `blocked` 就别提交，把关键几行报给用户。
- `image_id` 用 `$ZN images` 里的完整仓库路径，且要和资源区对得上。不传则平台选默认，**事后没有任何 API 能查回用了哪个镜像**。
- **选镜像先问用户能不能直接给出**（开发机/历史任务用的那个镜像名或 image_id）；平台不记录存量开发机的镜像，只有用户手上有。用户给不出再自己按代码的 CUDA / Python 依赖从 `$ZN images` 里挑。
- 镜像目录按 offering × workload × 区隔离，`total: 0` 表示"这里没有任务镜像"（如只有开发机路由的规格），不是报错。
- 日志 `lines[]` 是**倒序**对象数组、正文在 `body`；元信息（`pending` / `truncated` / `log_state`）在 stderr。
- 取消是否生效看 `replicas`（`Stopped` + `failure_message`），`job.status` 会滞后；`started_at: null` 说明没跑过、没扣卡时。
- 任务没有交互终端、不能 ssh；容器 `/` 不持久，checkpoint 写 `/personal_fast_storage`。
- 训练没有运行时上限，死循环会一直吃卡时。
- `available:false` 只是当前没余量；`job_available:true` 仍可提交并排队。

## 计费

- **卡时消耗顺序必须问用户**，不要自己定：用个人额度还是项目池（`--project-id` + `--funding-mode`），以及跑标准任务还是低优（低优不扣卡时）。不传 `funding_mode` 是平台默认，可能直接扣个人额度；提交前把选择复述给用户确认。
- 标准任务扣卡时；**低优（`low_priority`）训练不扣个人/项目卡时**（记录用量、可被抢占、回收后按原命令重排），个人 API 的低优训练仅资源区 5 有路由。**低优开发机照样扣卡时。**
- `funding_mode`：`personal`/`personal_only` 只用个人；`project` 先项目分配额度再共享池；`*_first` 选中来源优先、再按 personal→allocated→shared 兜底；`*_only` 不外溢。项目模式需 `--project-id`。不传＝平台默认；标准训练实际先项目后个人，两侧耗尽后进 3 小时个人宽限。
- 余额看 `$ZN hours`（个人 `remaining_card_hours` / `project_pools[].available_card_hours`）。

## 错误

| 退出码 3 | token 缺失/失效 → 见上，别重试循环 |
| 退出码 4 | 缺 scope，按 `required_scopes` 让用户调权限 |
| 退出码 5 | 幂等或状态冲突：先 `$ZN jobs` 看是否已有同名任务 |
| 退出码 6 | 429/503，按 `retry_after_seconds` 退避后用**同一 intent** 重试 |
| 退出码 7 | 本地等待超时/结果待定，用 `jobs` 核实，不要当成没提交 |

JSON 走 stdout、诊断走 stderr。能解析 JSON 不等于成功，要核对 `status`、`receipt.state` 与日志内容。
