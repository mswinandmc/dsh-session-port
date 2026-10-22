# Releasing / 发版流程（维护者）

本仓库的 CI 与发版全部在 GitHub Actions 里。这份文档只给维护者看，面向用户的安装说明见
[README.md](README.md)。

## 流水线

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push 到 `main`、每个 PR、手动 | Ubuntu + Windows × Node 22/24：manifest 预检、单元测试、ZIP 互操作测试、`npm pack --dry-run` |
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

## 发版步骤

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

