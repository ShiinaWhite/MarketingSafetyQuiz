# R2 一次性基础设施配置（R2_FAST_TRANSFER_V1）

本轮把「大文件数据面」从 Cloudflare Tunnel 移走：

| 流量 | 迁移前 | 迁移后 |
|---|---|---|
| APK 下载（约 52MB） | 手机 → update.shiinalab.top → Tunnel → PC | 手机 → **download.shiinalab.top → R2**（不经 PC） |
| capture.jpg 上传 | 手机 → update.shiinalab.top → Tunnel → PC | 手机 → **R2 presigned PUT → 私有 bucket**（不经 PC） |
| run.json / feedback / auth / latest | Tunnel → PC | **不变**，仍走 Tunnel → PC |

控制面（小请求）继续由 Collector 承担；只有大文件被移出 Tunnel。

---

## 为什么需要你手动做一次

创建 **R2 S3 API credential**（Access Key ID / Secret Access Key）需要账号级权限，
而 `wrangler` 只能签发 Cloudflare OAuth token，**无法**生成 R2 的 S3 credential。
脚本刻意不持有账号级权限，所以这一步必须由你本人在 Dashboard 完成一次。

在此之前，脚本不会伪造任何 bucket / domain / 配置状态。

---

## 步骤 1：登录 wrangler（浏览器授权）

```bash
npx wrangler login
```

会打开浏览器，点 **Allow**。授权只用于创建 bucket / 绑定域名 / 设置 lifecycle。

## 步骤 2：创建并配置基础设施

```bash
# 先看当前状态（只读）
node tools/r2/setup_r2.js --check

# 实际创建（需要 shiinalab.top 的 Zone ID）
node tools/r2/setup_r2.js --apply --zone-id <ZONE_ID>
```

Zone ID 位置：Cloudflare Dashboard → 选择域名 `shiinalab.top` → **Overview** → 右下角 **Zone ID**。

该脚本会：

- 创建两个 bucket：
  - `marketing-safety-quiz-downloads`（公开 APK）
  - `marketing-safety-quiz-samples`（私有样本）
- 关闭两个 bucket 的 **r2.dev 公开开发 URL**（不依赖它）
- 把 `download.shiinalab.top` 绑定到 downloads bucket（自动创建 DNS 记录）
- 对 samples bucket 执行 `local-uploads enable`
- 对 samples bucket 加 lifecycle：`samples/` 90 天过期、`tmp/` 7 天过期

> 不想用命令行绑定域名，也可以在 Dashboard 做：
> **R2 → marketing-safety-quiz-downloads → Settings → Custom Domains → Connect Domain**，
> 填 `download.shiinalab.top`。

## 步骤 3：创建 R2 S3 credential（必须手动，一次性）

Dashboard 路径：

1. **R2** → 左侧 **API** → **Manage API Tokens**
2. **Create API Token**
3. 权限：**Object Read & Write**
4. 资源：**只勾选**
   - `marketing-safety-quiz-downloads`
   - `marketing-safety-quiz-samples`
   （least privilege：不要给全账号，也不要 `Admin Read & Write`）
5. 创建后会显示一次 **Access Key ID** 与 **Secret Access Key**（Secret 只显示一次）

**Account ID** 在 **R2 → Overview** 右侧，或 Dashboard URL 里那串 32 位 hex。

## 步骤 4：写入本机 secret 文件

```bash
cp tools/sample_collector/.env.r2.example tools/sample_collector/.env.r2.local
# 编辑 tools/sample_collector/.env.r2.local 填入上面四个值
```

`.env.r2.local` 已在 `.gitignore` 中。**不要**提交、不要贴到聊天、不要放进 APK。

## 步骤 5：验证

```bash
node tools/r2/setup_r2.js --check     # 基础设施状态
node tools/r2/verify_r2.js            # 真实连通性 + 公开/私有边界 + 性能实测
node tools/r2/secret_scan.js          # 确认 secret 没有泄漏到 Git/前端/APK
```

`verify_r2.js` 会实际检查：

- samples bucket 匿名 GET / LIST / PUT 全部被拒绝（403）
- 刚上传的样本对象匿名读也被拒绝
- download bucket 的 APK 可匿名 GET，且 `Cache-Control: immutable`
- `SAMPLE_R2_LOCAL_UPLOADS = ENABLED`
- presigned PUT → HeadObject 完整闭环
- APK 下载速度 / PC 侧上传速度

## 步骤 6：发布新版（APK 走 R2）

```bash
node tools/dev_update/publish.js --notes "Move large transfers to Cloudflare R2"
```

发布流程会：构建 → aapt/apksigner 校验 → SHA256 → 上传 R2 → HeadObject 校验 →
Custom Domain 轻量冒烟（HEAD + 前 1MB 比对）→ **最后**才写 `latest.json` → prune 旧 APK。

失败时 `latest.json` 保持不变，仍指向旧版本。

---

## 安全边界（必须保持）

| Bucket | 公开性 | 允许 |
|---|---|---|
| `marketing-safety-quiz-downloads` | 公开只读 | 匿名 GET/HEAD APK；**不允许**匿名写；不放样本/secret/run.json |
| `marketing-safety-quiz-samples` | **完全私有** | 仅 R2 credential 与未过期 presigned URL；**无** Custom Domain、**无** r2.dev、**无**匿名 LIST |

presigned URL 性质：只授权单个 object key、只允许 PUT、TTL 300 秒、不落盘、不打日志。

## 生命周期与长期保存

- R2 samples bucket：`samples/` 90 天后删除 —— R2 是「高速接收层 + 90 天云端缓冲」
- **PC `real_samples/` 才是长期副本**：Collector 的 `mirror` worker 在 commit 成功后
  后台从 R2 拉回 `capture.jpg`（`.tmp` → SHA256 校验 → rename），失败会记录
  `mirror: failed` + `nextRetryAt` 并自动重试；Collector 重启后继续扫描未镜像对象。
- 因此**不要**在确认 mirror 机制失效的情况下依赖 90 天删除作为唯一副本来源。
