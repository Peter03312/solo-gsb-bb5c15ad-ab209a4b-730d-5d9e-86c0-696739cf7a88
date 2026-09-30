# 巡展作品光照预算 Web 工作台

为巡展作品管理**光照曝光预算**的本地 Web 工作台：Node.js + SQLite + 浏览器页面，全部数据保存在本机，无需任何外部服务。

## 核心规则

- **曝光单位**：`lx·min`（勒克斯·分钟）。曝光量 = **实际经过分钟数 × 照度**。
- **作品预算**
  - 录入：展期曝光上限、既有累计曝光。
  - `已用` = 既有累计 + 所有**已结束**时段的实际曝光。
  - `预占` = 进行中时段（按计划值）+ 全部未开始时段计划曝光。
  - `余额` = 上限 − 已用 − 预占（为负以红色标出）。
- **展厅时段**：录入起止时间、照度、展出作品（可多件）。
- **整批校验、整批拒绝**：排期调整以“整批替换全部未开始时段”方式提交。
  1. 同一作品任意两个时段时间区间不得重叠（半开区间 `[起, 止)`，首尾相接不算重叠）；
  2. 已用 + 进行中预占 + 全部未开始预占不得超过该作品上限；
  3. 任一作品任一条件不满足，**整批拒绝**，并在返回中指明作品编号/名称与冲突时段（可点击定位到编辑区对应行）。
- **开始（冻结）**
  - 时段开始后**原排期冻结**：时间、照度、作品均不可再调整，预算中继续保留其预占。
  - 若该时段在当前预算下已无足够额度，**禁止启动**。
- **结束（补记实际）**
  - 补记实际开始、实际结束、实际照度；**实际曝光替换该时段预占**。
  - 若超量导致后续排期预算不足：按**开始时间、再按编号**顺序标出不可开始的时段及每件作品的**缺口**（需要 / 可用 / 缺口），这些时段被禁止启动；调整排期后自动重新核算。
- **无效输入拒绝**：结束不晚于开始、负照度/负累计、未知作品、空作品列表等一律拒绝。
- **并发控制（乐观锁）**：所有写操作必须携带当前 `version`；版本过期返回 `409` 与**最新预算全量数据**，前端自动载入并提示重新调整。
- 已结束时段按**实际起止区间**参与后续重叠判定。

## 一键启动（Docker Compose，推荐）

前置：已安装 Docker（含 Compose 插件）。

```bash
docker compose up -d --build
```

首次启动自动：

1. 编译安装依赖；
2. 创建 SQLite 数据库（持久化卷 `light-data`）；
3. 建表并写入一套演示数据（1 件含“不可启动”时段、1 件进行中、多件未开始）。

打开浏览器访问：

> **http://localhost:8080**

停止 / 查看日志 / 重置数据：

```bash
docker compose logs -f
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除数据（下次启动重新初始化）
```

## 本地直接运行（Node.js 20+）

> 依赖 `better-sqlite3`，本机如无预编译兼容二进制会自动从源码编译，需要 `python3 / make / g++`。

```bash
npm install
npm start
```

运行测试：

```bash
npm test
```

数据库文件默认位于 `./data/light.db`；删除该文件后重启即重新初始化演示数据。

## 配置

均通过环境变量配置（见 `docker-compose.yml`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口（容器内） |
| `HOST_PORT` | `8080` | 宿主机映射端口，仅 Compose 使用，例如 `HOST_PORT=9090 docker compose up -d` |
| `DB_PATH` | 容器 `/data/light.db`；本地 `./data/light.db` | SQLite 数据库路径 |
| `TZ` | `Asia/Shanghai` | 容器时区，影响日志与时间显示 |

页面地址：`http://localhost:<HOST_PORT>`（默认 **http://localhost:8080**）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态：version、各作品已用/预占/余额、时段、不可启动清单、重叠冲突 |
| POST | `/api/artworks` | 录入作品（body 含 `version`、`code`、`title`、`cap_lux_min`、`existing_lux_min`） |
| PATCH | `/api/artworks/:id` | 修改作品预算 |
| PUT | `/api/schedule` | **整批替换**未开始时段（body：`{version, slots:[{id?,hall,start_at,end_at,lux,artwork_ids}]}`；`id` 省略表示新增，未出现的旧未开始时段删除） |
| POST | `/api/slots/:id/start` | 开始时段：冻结原排期、保留预占 |
| POST | `/api/slots/:id/finish` | 结束补记：`{version, actual_start_at, actual_end_at, actual_lux}` |

时间统一使用 ISO 8601（`2026-10-01T09:00:00.000Z`）。成功返回最新全量状态；校验失败返回 `422`（含 `details`，逐条指出冲突作品/时段/缺口）；版本过期返回 `409` 并携带最新预算。

## 目录结构

```
Dockerfile               # 多阶段构建，原生模块源码编译
docker-compose.yml       # 一键启动 + 数据卷 + 健康检查
.npmrc                   # 强制 better-sqlite3 源码编译
src/server.js            # HTTP 服务与静态页面
src/db.js                # SQLite 建表、初始化数据、事务与乐观锁
src/budget.js            # 曝光计算、余额汇总、整批校验（纯函数，可独立测试）
public/                  # 前端页面（原生 HTML/CSS/JS，无构建步骤）
test/test.js             # 14 项端到端规则测试
```
