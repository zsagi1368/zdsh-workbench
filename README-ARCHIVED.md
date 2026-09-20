# ⚠️ ARCHIVED / 已归档冻结 — 请勿在此开发

> **EN**: This repository (`zsagi1368/zdsh-workbench`) is ARCHIVED and frozen at commit
> `06cabe4` (2026-09-07). It is kept as the historical source of truth only. The one
> authoritative workbench now lives in-tree in the main harness repository at
> `packages/client/workbench` (branch `zdsh-latest`). Do not develop here; no further
> feature commits will be accepted. Full English summary in §5 below.
>
> **中文**：本仓（`zsagi1368/zdsh-workbench`）已归档，HEAD 冻结于 `06cabe4`（2026-09-07），
> 仅作历史真源留档，不再接受任何功能提交。workbench 唯一正典=主仓 in-tree
> `packages/client/workbench`（zdsh-latest 线）。请勿在此开发。

## 1. 归档声明

- 本仓 HEAD 冻结于 `06cabe4df1cc3c00087f02d88c1dc646d13a2d26`（2026-09-07 12:06 +0800，"chore(deps): pin dsh-host-webserver to =0.1.2-rc.1 (zDSH rc.1 baseline)"），此后不再接受功能提交。本文件所在提交为 Gate-W 收口文书提交（A-1.3.1 判据：独立仓写 README-ARCHIVED 后零新提交——自本提交起生效）。
- **删除权归用户本人**。AGENTS.md §5 铁律原文引用：
  > 「备份删除权永远归用户（用户 2026-09-02 裁定，取代旧 7 天条款）：agent 完成改动并验证无误后，【提示用户】由用户本人删除备份；任何 agent（含主线）永久禁止删除/修改/覆盖/清空/改写备份区内容——不存在"保留期满可清理"的例外。」

  本仓归档后适用同一语义：任何 agent 永久禁止删除/清理本仓，去留由用户本人决定。

## 2. 权威指针（唯一正典）

- workbench **唯一正典** = 主仓 deepseek-harness-zDSH（zdsh-latest 线，本地路径 `G:\000Github\zDSH\zDSH-main`）之 in-tree 包 **`packages/client/workbench`**（R-1.3.1 裁定 / Q2 追认）。
- 收编性质：**源码收编，非出厂装配收编**（bundle/boot 零挂载，V13/V28 在案）；in-tree 包自述句 "Vendored from zDSH Workbench (clean-room independent development)" 在案（V13）。
- 本仓 = 历史真源留档（origin `https://github.com/zsagi1368/zdsh-workbench.git`，云端 main 与冻结 HEAD 一致，R7 §1.2 实测）。

## 3. 差集表引用（R7 盘点实测）

出处 = 战役目录 `zDSH-docs\Plan\campaigns\2026-09-14-zdsh-plugin-intake-verify\` 之 **R7-inventory.md §2.1 差集表**（差集表原文载体，行级漂移行）+ **PROGRESS-exec.md:18**（TC-R7-INV 定论记录）：

| 维度 | 实测值 | 出处 |
|---|---|---|
| in-tree 独有（领先） | ~**1011** 行（含 compat 守卫、i18n、host/client 测试分拆、git-runner 扩展、0.1.5 契约适配） | R7-inventory.md §2.1 / PROGRESS-exec.md:18 |
| 真源独有合计 | ~489 行，其中双 README 文案占 375 行 | R7-inventory.md §2.1 |
| 真源独有**代码残量** | ~**114** 行（≈489−375），集中于 `git-runner.ts` / `pty-registry.ts` 两分叉段 | PROGRESS-exec.md:18 / R7-inventory.md §2.5、§3-U2 |

R7 §2.5 定性（推断，置信度高）：in-tree ≈ 分叉基线的主线向超集演化；真源仓剩余独有面基本是独立发行外壳（dsh.plugin.json / cordis.patch.yml / pnpm-workspace / CHANGELOG / docs / 独立 README 文案 / 旧 pin 体系）。

## 4. 处置声明（主线签认原文照录）

主线签认（2026-09-21，采 planner 倾向）：

> 114 行独有残量**声明不收编、随仓归档冻结** + backlog 登记「未来如需收编另评」（触发条件=用户要求）。
> 理由：workbench 唯一正典=in-tree 已裁；残量属真源实验面且落后两基线（F16）；A-1.3.3 判据的「声明处置」分支兑现。用户可翻案（翻案=改本文书并重裁）。

## 5. 双语注记 / Bilingual note

本仓既有文书惯例 = README.md（英）/ README.zh.md（中）成对双语。本文件仿 zdsh-plugin-registry 归档先例（检疫区草稿仓 commit `65edb3f` 之 README-ARCHIVED.md 形制）：中文为主 + 顶部双语警示 + 本节英文摘要，不另立 `.zh` 伴生文件（归档声明为单份收口文书）。既有 README.md / README.zh.md **零改动**——冻结仓最小触碰，不加头部指针行（决策理由登记于战役回执 RECEIPT-CW-progress.md）。

**EN summary**: This repository is archived and frozen at `06cabe4` (2026-09-07); no further feature commits will be accepted. The sole authoritative workbench is the in-tree package `packages/client/workbench` (branch `zdsh-latest`) in the main deepseek-harness-zDSH repository; this repo remains as the historical source of truth (source-level vendoring only — never factory-assembled into any bundle/boot). Per the R7 inventory (campaign 2026-09-14-zdsh-plugin-intake-verify), the in-tree copy leads by ~1011 unique lines, while this repo holds ~114 lines of unique code remainder concentrated in `git-runner.ts` / `pty-registry.ts`; mainline ruled on 2026-09-21 that this remainder is NOT merged back — it stays frozen with this archive, with a backlog item to re-evaluate only upon user request. Deletion rights belong exclusively to the user (AGENTS.md §5): no agent may ever delete or clean up this archive.

## 归档信息 / Archive metadata

- 归档时间：2026-09-21
- 归档执行：TC-B4-CW 任务卡（campaigns/2026-09-14-zdsh-plugin-intake-verify），Gate-W A-1.3.1/A-1.3.3 收口；coder-CW
- 采取行动原文记录：仅新增本文件（纯新增，无原件损失，未动用 del/ 备份）；既有 README.md / README.zh.md 及其余全部文件零改动；本地 main 单枚 commit 不 push——push〔云〕门归主线 REVIEW 后执行（K-1.3.1：归档声明须 push 上云方对外生效）
- 处置建议：本仓去留（保留/删除）由用户本人决定，任何 agent 永久禁止清理
