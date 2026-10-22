# dsh-session-port · 会话导入导出

> DeepSeek Harness plugin: export a session as a ZIP archive (attachments included) or import an
> exported session back as a new conversation. Archive layout is byte-compatible with DSH's
> built-in "Download session log" export.

把 DSH 的会话**导出成压缩包**带在身边，或把导出的会话**导入成新会话**继续用。
附件（截图、文件）随会话一起搬运。

## 安装

已发布到 npm 与 GitHub。任选一种方式；`--profile` 后面换成主人自己的 profile
名（桌面版是 `desktop`，Web 版常见 `web`）。

**命令行（推荐）**

```bash
# 从 npm 安装（官方源；会自动写进 profile 的 bundles 列表）
dsh plugin --profile desktop add dsh-session-port

# 没装 dsh CLI 时用完整包名（npm 上那个 `dsh` 是同名旧包，不能用）
npx @deepseek-ai/dsh plugin --profile desktop add dsh-session-port

# 从 GitHub 仓库安装
dsh plugin --profile desktop add github:mswinandmc/dsh-session-port

# 从本地打包安装（在仓库目录 `npm pack` 后，把生成的 .tgz 装进 profile）
npm pack
dsh plugin --profile desktop add '<repo>\dsh-session-port-<version>.tgz'
```

装好后用这些命令查看/升级/卸载：

```bash
dsh plugin --profile desktop list --depth 0                 # 确认 dsh-session-port 在列表里
dsh plugin --profile desktop update dsh-session-port        # 升级到 npm 最新版
dsh plugin --profile desktop remove dsh-session-port        # 卸载
```

**图形界面**：DSH「设置 → 插件」里安装 npm 包 `dsh-session-port`（bundle 名同为
`dsh-session-port`），或把本仓库目录交给 Plugin Manager 以 bundle 方式安装（目录里的
`cordis.patch.yml` 会插入 `dsh-session-port` 行）。

安装后**重启桌面版应用**（命令行安装的插件在下次启动时加载；已开着的页面需刷新），
标题栏右侧出现导出按钮、侧边栏底部出现导入按钮。

## 用起来

> 首次安装后需要**刷新一次页面**（F5 / Ctrl+R），页面才会加载插件的浏览器半边。

| 想做的事 | 操作 |
| --- | --- |
| 导出正在看的会话 | 打开会话 → 标题栏右侧的「导出」图标（↓）→ 浏览器下载 `<标题>-<会话 id>.zip` |
| 导入一个会话 | 左侧栏底部的「导入会话」图标（↑）→ 选择 `.zip` 或 `.jsonl` → 自动导入并打开新会话 |

导入的会话：

- **新建**，绝不覆盖或删除已有会话；
- 落在**当前会话所在的工作区**（空闲时落在最近的工作区）；
- 从原会话继承标题、完整对话与工具历史、模型/预设（预设在本机不存在时自动退回默认）；
- 日志里指向原会话的内部标记（投递水位等）会自动改写成新会话，否则 DSH 会拒绝加载该会话的历史；
- 子会话（`subagents/`）不随导入恢复，导入的是主会话本身。

也可以用自然语言让本鲸帮忙，例如「把当前会话导出到 D 盘备份」——插件注册了 `session_port` 工具。

## 文件格式

导出格式与 DSH 自带的「下载会话日志」完全一致，两种来源的压缩包都能互相导入：

```
<标题>-<会话 id>.zip
├── session.v4.jsonl                 # 第一行会话头，随后每行一条会话事件
├── media/<attachmentId>.<ext>       # 会话引用的图片
└── files/<前缀>/<摘要>/<文件名>      # 会话引用的文件
```

会话日志（`.jsonl`）本身就是合法的导入输入，便于人工检查或跨版本处理。

## 边界与已知限制

- 导入要求**格式版本一致**：v4 的压缩包导入当前 DSH；跨大版本请先用对应版本 DSH 打开再重新导出。
- 单次导入默认上限 512 MiB，可在插件配置里用 `maxImportBytes` 调整。
- 导入只恢复主会话；子会话、会话收藏/置顶/归档等**列表状态**不迁移。
- 会话的 `cwd` 以当前工作区为准；原目录在本机不存在时不会被记录。

## 配置（`cordis.patch.yml` 的插件行）

```yaml
- id: session-port
  name: dsh-session-port
  config:
    maxImportBytes: 536870912      # 单次导入上限，默认 512 MiB
    includeAttachments: true       # 导出时是否打包附件
    sessionFormatVersion: 4        # 仅在会话库为空、无法自动探测时使用
    exportDirectory: ''            # agent 工具导出目录，默认 <DSH_HOME>/session-port/exports
```

## 实现

- 宿主端 `index.js`：`/session-port/{info,export,import}` 认证路由 + `session_port` 工具；
  两个入口调用 `lib/host.js` 里的同一组实现，所以格式与失败语义不会分叉。
- `lib/host.js`：导出走 `sessionQuery.readSession`（与自带导出同一份已校验视图），
  导入通过 `sessionPersistence.create → append → flush → close` 落盘，再挂到工作区。
- `lib/format.js`：纯函数（JSONL 序列化/解析、附件引用收集与改写、文件名清洗），有单测。
- `lib/zip.js`：无依赖 ZIP 读写（基于 `node:zlib`），有单测。
- `client.js`：没有 `@deepseek-ai/*` 运行时依赖的客户端半边，只用 `react` 与宿主主题变量。

## 验证

```bash
cd dsh-session-port
node --test test/format.test.mjs   # 13 项：JSONL 序列化/解析、附件引用、投递标记、文件名
node --test test/host.test.mjs     # 19 项：导出→导入往返、真实 zip 工具产物、投递标记改写、失败路径
node --test test/client.test.mjs   #  6 项：浏览器半边注册与渲染路径（无浏览器沙箱）
node --test test/zip.test.mjs      # 34 项：ZIP 读写、data descriptor 流式 zip、损坏输入
```

已在本机完成的端到端验证：

- 用插件工具导出当前会话（948 条事件）→ 独立 Python `zipfile` 校验压缩包结构、JSONL 头与事件连续性；
- 用插件工具把该压缩包导入回当前工作区 → 新会话落盘（`sessions/--D-hyw--/<新 id>/session.v4.jsonl.zstd`，948 条事件、序号连续），并自动加入 `D:\hyw` 工作区的会话列表；
- 浏览器路由已注册并通过 Connection 信任栅栏（未认证请求全部 401）；
- 界面按钮的渲染与点击需刷新页面后点击验证（本会话无浏览器控制能力，未做视觉验收）。

## 发布流程（维护者）

本仓库的 CI 与发版都在 GitHub Actions 里：

- **`ci.yml`**：push 到 `main` 和每个 PR 上，在 Ubuntu + Windows × Node 22/24 跑
  manifest 预检、单元测试、ZIP 互操作测试与 `npm pack --dry-run`。
- **`release.yml`**：推送 `v*` tag 触发。它校验 tag 与 `package.json` 版本一致、
  跑全部测试、用 **npm trusted publishing（OIDC，无需 token / 无需 2FA）** 发布，
  然后创建带自动 changelog 的 GitHub Release。预发布 tag（如 `v0.2.0-beta.1`）
  只会发到 `beta` dist-tag，不会动 `latest`；重复跑历史 tag 安全（已发布的版本跳过）。

一次性设置：在 npm 包页面 **Settings → Trusted Publishers** 添加 GitHub Actions，
仓库填 `mswinandmc/dsh-session-port`、workflow 填 `release.yml`（环境留空）。

之后每次发版：

```bash
# 1) 改 package.json 版本（如 0.1.2），提交
git commit -am "chore: release 0.1.2"
# 2) 打 tag 并推送 → Actions 自动测试、发布 npm、建 Release
git tag v0.1.2
git push origin main --tags
```

本地预检：`npm run check`（= manifest 预检 + 单元测试）。
