# CLAUDE.md — Online Saler

本文件是 Claude 在本仓库工作的规则。

## 一、这是什么

肯尼亚 Kikuyu 的二手服装线上交易平台（MVP）。第一阶段目标：把 1000 件实物二手衣服变成可在线购买、单件唯一追踪的商品。

一件衣服 = 一个库存记录 = 一个库位，卖掉即下架，不存在同款多件。

**这是公开仓库（PUBLIC）**，且包含 M-Pesa 支付集成。提交任何内容前都要意识到它对外可见。

MVP 范围内：商品数字化（条码 / 拍照 / AI 提取 / 人工校准 / 上架）、唯一库存、顾客商城、M-Pesa 支付与对账、仓库作业（入库 / 拣货 / 打包 / 自提 / 配送）、分销归因与周结佣金、管理后台。

MVP 范围外：多商家市场、多级分销、原生 App、全国配送自动化、AI 推荐。

## 新会话 / 新成员先读这里（10 分钟上手）

1. **克隆后先切到 `develop`**：GitHub 默认分支可能还是 `main`，但 `main` 停在 2026-08-13，不代表线上（见第三节）。`git checkout develop && git pull`。
2. 按顺序读：本文件 → `README.md` → `docs/architecture/system-overview.md` → `docs/business-rules/mvp-rules.md` → `docs/deployment/staging-production.md`。`project/` 下的登记表不要当真（第七节）。
3. 跑一遍 `npm install && npm run ci`，全绿再动手。
4. 先看最近 20 个合并的 PR（`git log --oneline -20 develop`），了解当前在做什么、代码风格和提交粒度。
5. 动手前确认三件事：要改的是不是五个高危状态机（第六节）？要不要改数据库 schema（第四节「数据库迁移」）？改动会自动上线哪个服务（第五节）？

## 后端代码地图（「后端」不只在 `apps/api`）

| 业务 | 代码在哪 |
| --- | --- |
| 商品数字化、图片处理、AI 识别、详情生成 | `apps/api/src/product`、`apps/api/src/ai` |
| 员工作业台后端（订单中心、仓库、客服、分销、结算、权限） | `apps/api/src/operations` |
| 商城读商品 / 搜索统计 | `apps/api/src/storefront` |
| 门店集成 | `apps/api/src/integration` |
| **下单、预留、M-Pesa 支付与对账、订单查询、分销归因、卖家看板** | **`apps/storefront/src/{checkout,payments,orders,affiliate,seller,cart,auth}` + `apps/storefront/src/app/api/*`（Next.js API 路由直接读写数据库）** |
| 定时任务入口（预留过期、支付对账、通知、定金过期） | `apps/storefront/src/app/api/internal/*`，由 Cloud Scheduler 调用，见 `docs/deployment/staging-production.md` |
| 共享业务常量与规则（预留分钟数、配送费、佣金等） | `packages/business-rules` |
| 数据模型 | `packages/database/prisma/*.prisma`（多文件 schema）+ `migrations/` |

NestJS 模块注册在 `apps/api/src/app.module.ts`。新增 `*.spec.ts` / `*.test.ts` 后，**要把文件加进对应 `package.json` 的 `test` 脚本**，否则 CI 不会跑它。

## 二、架构

npm workspaces 单体仓库，Node >= 20。

| 目录 | 是什么 | 技术 |
| --- | --- | --- |
| `apps/storefront` | 顾客端商城 | Next.js + Remotion + Konva |
| `apps/operations` | 员工作业台 | Next.js + TanStack Table + jsbarcode |
| `apps/admin` | 管理后台 | Next.js |
| `apps/api` | 统一后端 API | NestJS + satori |
| `apps/worker` | 异步任务（图片处理、预留过期、佣金确认、通知） | Node |
| `apps/image-processor-lightweight` · `apps/image-processor-rembg` | 图片抠图处理 | Python |
| `packages/database` | Prisma schema 与迁移（45 个模型，1371 行） | Prisma 6 |
| `packages/shared-types` · `business-rules` · `ui` · `config` | 共享包 | TypeScript |

后端按中台模块组织：Foundation / Product / Inventory / Transaction / Payment / Fulfillment and Returns / Affiliate and Commission / Data Operations。

## 三、分支策略（注意与文档不一致）

README 和 `docs/development/branch-strategy.md` 写的是：所有工作先进 `develop`，集成测试通过后再从 `develop` 提升到 `main`。

**但实际情况是：`main` 停在 2026-08-13，而生产环境是从 `develop` 手动部署的（2026-09-15 仍在部署）。** 也就是说 `main` 已经脱离实际使用。

因此：

- 新分支从 `develop` 切出，PR 目标分支为 `develop`
- 不要假设 `main` 代表线上状态
- 若用户希望恢复 `develop → main` 的提升流程，这是一次单独的讨论，不要顺手做

分支命名：`feature/*`、`fix/*`、`docs/*`。

## 四、常用命令

```bash
npm install

# 仓库骨架检查 + 生成 Prisma client + 全量构建 + 测试
npm run ci

# 单项
npm run check:repo          # 校验必需文件是否齐全（缺一即失败）
npm run typecheck
npm run test
npm run build

# 各应用本地开发
npm run dev:storefront
npm run dev:operations
npm run dev:admin
npm run dev:api
npm run dev:worker

# 数据库
npm run db:generate
npm run db:migrate
```

`npm run check:repo` 会校验一份必需文件清单（各 app 的 README、docs 下的架构 / 业务规则 / 分支策略 / 部署文档、`project/` 下四份登记表、tests 与 infrastructure 的 README）。**新增目录时如果漏了 README，CI 会失败。**

### 数据库迁移

- 迁移只追加，不改已合并的迁移目录。目录名用 `YYYYMMDDHHMMSS_描述`。
- 新增**结构性**迁移时，必须同时把目录名追加到 `scripts/prepare-integration-db.mjs` 的 `migrations` 数组末尾，否则 CI 的 Database integration 会失败。
- 不要对任何云上数据库执行 `prisma db push` 或 `migrate dev`。云上迁移由 `deploy-api-staging.yml` 的迁移 Job 在 push `develop` 时执行。
- 多人同时改 schema 时容易撞迁移顺序：开 PR 前先 rebase 最新 `develop`，确认自己的迁移排在最后。

### 本地跑数据库集成测试

```bash
docker compose up -d   # 本地 Postgres 16
# 另建一个名字里带 test 的空库，例如 online_saler_test
export MVP_INTEGRATION_DATABASE_URL=postgresql://online_saler:online_saler_dev@localhost:5432/online_saler_test
export DATABASE_URL=$MVP_INTEGRATION_DATABASE_URL MPESA_ENVIRONMENT=sandbox
npm run db:generate && node scripts/prepare-integration-db.mjs
npm run build:api && npm run test:integration
```

`prepare-integration-db.mjs` 只接受 localhost 且库名含 `test` 的空库，并需要完整 git 历史（浅克隆要先 `git fetch --unshallow` 或 `--depth=1000`）。

## 五、部署

部署在 Google Cloud Run（项目 `online-saler-staging`，区域 `africa-south1`）。

- `deploy-api-staging.yml` / `deploy-operations-staging.yml` / `deploy-storefront-staging.yml` — staging
- `deploy-storefront-production.yml` — **生产，仅手动触发**，需输入 `deploy-production` 确认字符串。始终按订单全额真实收款。
  - `one_ksh`（1 先令 + 白名单）测试模式已于 2026-09-19 按用户指示删除：它一旦被选中，所有非白名单顾客都无法付款。**不要再把收款模式选项加回部署表单。**
- `deploy-storefront-staging.yml` 名字叫 staging，但用的是**生产 M-Pesa 密钥、真实全额收款**、和线上共用数据库。平时 `ingress=internal`，测试时临时改 `all`，测完改回。

**不要触发生产部署。** 需要上生产时，把情况说明给用户，由用户自己执行。

M-Pesa 生产密钥存放在 Google Secret Manager，**不得写入 GitHub repository secrets、源码、PR 评论或 Issue 评论**。清单见 `project/PRODUCTION_LAUNCH_CHECKLIST.md`。

## 六、提交方式：分支 + PR 到 `develop`

（替代 2026-09-17 的「直接推 develop」做法。近期实际一直走 PR，如 #211–#214。）

- 从最新 `develop` 切 `feature/*`、`fix/*`、`docs/*` 分支，PR 目标 `develop`，保持 PR 小。
- **不要直接 push `develop`**。push / 合并到 `develop` 会自动部署 api 和 operations，而它们和线上共用数据库，等于上线。
- Eric 的规则（2026-10-16）：Eric 本人的会话所开 PR，CI 通过后可以直接合并，无需再问。**其他团队成员的 PR 由 Eric（CODEOWNERS）审核后合并**，除非 Eric 另行授权。

提交前自查（PR 模板里也有）：

- [ ] `npm run ci` 通过（含 `check:repo`、Prisma 生成、构建、测试）；动了数据库或支付再跑一遍集成测试
- [ ] 新增目录都补了 README（否则 `check:repo` 失败）
- [ ] 新增测试文件已加入 `test` 脚本
- [ ] 未引入密钥、凭证、商户号、真实客户数据（**这是公开仓库**）
- [ ] 未在无确认的情况下改动订单 / 支付 / 库存 / 退货 / 佣金状态机

PR 模板（`.github/pull_request_template.md`）要求勾选 Scope、Validation、Risk Check，照实填写。

**订单、支付、库存、退货、佣金这五个状态机是高危区域**，改动前先跟 Eric 确认，并在 PR 描述里单独写明。

## 七、项目登记表实际没在用

`project/BUGS.md` 至今写着"还没有记录任何 bug"，但仓库已合并 200 多个 PR。`TASKS.md`、`CHANGE_REQUESTS.md` 情况类似。

引用这些文件判断项目状态会得出错误结论。**真实状态以 git log、PR 记录和 Cloud Run 上的实际部署为准。** 若用户希望重新启用这套登记流程，属于单独任务。

## 八、我的工作规则

Eric 已授权全面接管：整理需求、写代码、开 PR 并在 CI 通过后合并到 `develop`（限 Eric 本人的会话，见第六节）、部署 staging、维护项目文档。

必须遵守：

- 提交前完成第六节的手动自检清单
- 不触发生产部署，不接触生产密钥
- 改动业务规则或上述五个状态机前先确认
- 保持 PR 小而可审查
- 这是公开仓库，任何提交都不得包含密钥、商户号、真实客户数据

Eric 是非开发者。每个 PR 要说明**页面上的变化是什么，如何点击验证**。

## 九、多会话 / 多人并行

用户会同时开好几个会话，现在也有其他团队成员加入。以前多个会话在同一个工作目录里直接往 `develop` 提交，互相把没做完的代码带进了别人的提交，staging 部署也坏过一次。规则：

1. 开工第一步：从最新的 `develop` 切一个分支（或 git worktree），**不要在别人正在用的工作目录里改代码**。
2. 不 push `develop`，不改 GitHub Actions 的变量、密钥和部署开关；staging 部署由合并触发，手动触发前先问 Eric。
3. 改 `packages/database/prisma/*.prisma` 时按第四节「数据库迁移」写迁移，并在 PR 描述里写明改了哪些字段。
4. 改公共代码（`packages/*`、`apps/api/src/foundation`、各应用共用的布局和鉴权）要单独成 PR，改动尽量小。
5. 交付时在 PR 描述里写明：页面上有什么变化、怎么点击验证、跑过哪些测试、是否动了五个状态机或业务规则。
6. 合并后确认 Cloud Run 上新修订版本起来了（看 `Deploy API to Staging` / `Deploy Operations to Staging` 工作流是否绿）。
7. 生产 storefront 永远由 Eric 手动触发（第五节）。

不确定时先停下来问 Eric，不要自己上线。
