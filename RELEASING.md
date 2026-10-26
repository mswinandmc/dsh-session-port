# Releasing / 发版流程（维护者）

本仓库的 CI 与发版全部在 GitHub Actions 里。这份文档只给维护者看，面向用户的安装说明见
[README.md](README.md)。

## 流水线

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push 到 `main`/`dev`、每个 PR、手动 | Ubuntu + Windows × Node 22/24：manifest 预检、单元测试、ZIP 互操作测试、`npm pack --dry-run` |
| [`release.yml`](.github/workflows/release.yml) | 推送 `v*` tag | 校验 tag 与 `package.json` 版本一致 → 跑全部测试 → 用 **npm trusted publishing（OIDC）** 发布 → 创建 GitHub Release |

发版认证使用 npm trusted publishing：**不需要 NPM_TOKEN、不需要交互式 2FA**，npm 会为
GitHub Actions 签发短时凭据并在 registry 上附带 provenance（SLSA v1）签名。

## 一次性设置（已完成）

npm 包页面 **Settings → Trusted Publishers** 添加：

- Publisher: **GitHub Actions**
- Organization/user: `mswinandmc`
- Repository: `dsh-session-port`
- Workflow name: **`release.yml`**（必须与文件名一致）
- Environment: 留空

换仓库或改 workflow 文件名后需要重新配置；改名前请先在新环境里发布一次完成校验。

## 分支与发布节奏（dev → 预览 → main → 正式）

两个长期分支，各管一条线：

| 分支 | 角色 | 说明 |
| --- | --- | --- |
| `dev` | 集成分支 | 所有改动先落这里；预览版和正式版的**版本号都在这里改** |
| `main` | 发布线 | 只反映已发布的内容，**只接受来自 `dev` 的快进合并**，不直接改代码 |

`main` 必须始终是 `dev` 的祖先（`git merge --ff-only dev`）。在 `main` 上直接提交会让两条线分叉，
下次合并就得造一个合并提交，版本号的先后关系也会乱。

### 发预览版（每次改动一个预览）

预览号用 `-pre<N>` 后缀；tag 里带 `-`，`release.yml` 就会把它发到 npm 的 **`beta`**，`latest` 不动，
也不会建正式 Release。

```bash
# 1) 在 dev 上把版本号推到下一个预览号（必须高于 npm 上已有的所有版本）
npm version 0.2.2-pre3 --no-git-tag-version
git commit -am "chore: preview 0.2.2-pre3"

# 2) 打 tag 并推送 —— 剩下的交给 Actions
git tag v0.2.2-pre3
git push origin dev
git push origin v0.2.2-pre3
```

装预览版的人用 `dsh plugin --profile web add dsh-session-port@beta`。

### 发正式版

```bash
# 1) 在 dev 上把版本号改成正式号（去掉 -preN），提交
npm version 0.2.2 --no-git-tag-version
git commit -am "chore: release 0.2.2"

# 2) main 只做快进合并，保证不分叉
git switch main
git merge --ff-only dev
git push origin main

# 3) 打 tag，触发正式发布（npm latest + GitHub Release）
git tag v0.2.2
git push origin v0.2.2
git switch dev
```

### 号段约定

- 版本号必须**单调递增**，且不能与 npm 上已发布的重复；重发同名版本会被 registry 拒绝。
- 已发布 `0.2.1`（latest）和 `0.2.2-pre1`、`0.2.2-pre2`（beta），所以 `0.2.2` 这条线的下一个预览从
  `0.2.2-pre3` 起，正式版收在 `0.2.2`。
- 一旦 `0.2.2` 正式发出，就**不能**再发 `0.2.2-preN`；下一条功能线换核心号，例如 `0.3.0-pre1`。
- 一个正式版对应同一核心号的一串预览；预览只是“这条线上还没定型的样子”，不是独立分支。

## 发版步骤

分支节奏见上一节（改动 → `dev` → 预览 → `main` → 正式）；这一节只讲 tag 与 Actions 的关系。

版本号遵循 SemVer，且只能有三段：`MAJOR.MINOR.PATCH`（可选 `-prerelease`）。
`0.1.3.1` 这类四段写法不合法，npm 会拒绝发布。

```bash
# 1) 改 package.json 的 version（正式版如 0.1.5；预发布如 0.2.0-beta.1）
git commit -am "chore: release 0.1.5"

# 2) 打 tag 并推送 —— 剩下的交给 Actions
git tag v0.1.5
git push origin main --tags
```

- tag 必须与 `package.json` 版本完全一致（`v0.1.5` ↔ `0.1.5`）；
- **预发布** tag（如 `v0.2.0-beta.1`）只会发到 npm 的 `beta` dist-tag，不会移动 `latest`；
- 已发布的版本会被跳过，所以重跑历史 tag 是安全的；
- 发布成功后 GitHub Release 自动创建，带 changelog 和 npm 链接。

如果只改文档、没有实际代码变更，不建议单独占一个版本号——等下次有代码改动时一起发。
README 的内容会随那次发布同步到 npm 页面。

## 本地预检

```bash
npm test          # format + host + client（38 项）
npm run test:zip  # ZIP 读写与真实工具互操作（34 项，会调用本机 PowerShell）
npm run check     # manifest 预检 + npm test
npm pack --dry-run  # 查看将要发布的文件清单
```

## 兜底：手动发布

trusted publishing 临时不可用时，维护者也可以在本机手动发布（需要 npm 账号 2FA）：

```bash
npm login
npm publish --access public
```

预发布版本需要显式 dist-tag：`npm publish --tag beta`。手动发布不会自动创建 GitHub
Release，需要另建；发布后请确认 registry 上的版本与 `package.json` 一致。

