# ins-neo-fetch

基于 [Neo CLI](https://github.com/4ier/neo) 的 Instagram 内容抓取工具。通过 Chrome DevTools Protocol (CDP) 连接真实浏览器会话，利用 Instagram 私有 API 下载目标账号的 Stories 和 Posts。

[English](./README.md) | 中文

## 特性

- **Stories & Posts** — 抓取活跃 Stories 和历史 Posts（支持轮播/多图帖子）
- **去重机制** — JSON 数据库追踪已下载内容，避免重复下载
- **日期归档** — 文件按 `用户名/stories|posts/YYYYMMDD/文件名` 结构存储
- **资源占用低** — 使用一个常驻 Chrome 实例，通过 CDP 发送 API 请求，无需每次启动浏览器
- **定时任务友好** — 脚本自动检测 Chrome/Neo 连接状态并重连

## 工作原理

本项目使用 [**Neo**](https://github.com/4ier/neo)（`@4ier/neo`）将已登录的 Instagram 浏览器会话转化为可编程 API。Neo 通过 CDP 连接运行中的 Chrome，在页面上下文中直接执行 `fetch()` 请求，继承浏览器的 Cookie 和认证状态，无需 API Token 或 Cookie 提取。

```
Chrome（已登录 Instagram）
  ↕ CDP（端口 9222）
Neo CLI
  ↕ neo eval / neo connect
ins-neo-fetch（本项目）
```

## 环境要求

- **Node.js** >= 18
- **Neo CLI** — `npm install -g @4ier/neo`
- **Chrome/Chromium** — 需要以 `--remote-debugging-port=9222` 启动
- 无头服务器需要 **Xvfb**（虚拟显示器）

## 安装

```bash
git clone https://github.com/Yoru0908/ins-neo-fetch.git
cd ins-neo-fetch
npm install
cp .env.example .env
# 编辑 .env 配置下载目录和目标账号
npm run build
```

## 配置

编辑 `.env`：

```env
DOWNLOAD_DIR=./downloads
TARGET_ACCOUNTS=account1,account2,account3
```

## 使用方法

### 1. 启动 Chrome

```bash
# 桌面环境
google-chrome --remote-debugging-port=9222 --user-data-dir=./chrome-profile https://www.instagram.com/

# 无头服务器（如 NAS）
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
chromium --remote-debugging-port=9222 \
    --user-data-dir=./chrome-profile \
    --no-sandbox --no-first-run \
    https://www.instagram.com/
```

### 2. 首次登录 Instagram

如果在远程服务器上运行，使用 SSH 端口转发在本地操作：

```bash
# 本地终端
ssh -L 9222:localhost:9222 user@server

# 本地 Chrome 打开 chrome://inspect/#devices
# 点击 Instagram 标签页的 "inspect"，在 DevTools 中登录
```

登录状态保存在 `chrome-profile` 目录中，只需登录一次。

### 3. 连接 Neo

```bash
neo connect 9222
```

### 4. 运行抓取

```bash
node dist/index.js
```

### 5. 定时任务

```bash
# 每 4 小时抓取一次
0 */4 * * * /path/to/scripts/ins-neo-fetcher.sh >> /path/to/logs/cron.log 2>&1

# 开机自启 Chrome
@reboot sleep 30 && /path/to/scripts/ins-neo-start-chrome.sh >> /path/to/logs/chrome-boot.log 2>&1
```

## 目录结构

```
downloads/
├── username1/
│   ├── stories/
│   │   └── 20260311/
│   │       ├── story_1234567890.jpg
│   │       └── story_1234567891.mp4
│   └── posts/
│       └── 20260310/
│           ├── posts_ABC123_987654_0.jpg
│           └── posts_ABC123_987654_1.jpg
├── username2/
│   └── ...
└── dedup_database.json
```

## 前端展示与存储方案

抓取到的内容可以通过多种方式在网页前端展示和存储。

### API Server（本地服务器）

配合一个简单的 API Server，可以扫描下载目录并生成文件列表 JSON，供前端消费：

```python
# api_server.py 核心逻辑
# 扫描 DOWNLOAD_DIR 生成 R2 兼容的 file-list.json
# 媒体直链指向 AList 或其他文件服务
DOWNLOAD_DIR = "/path/to/downloads"
ALIST_BASE = "http://your-server:5244"
ALIST_MOUNT = "/instagram"
API_PORT = 8082
```

API Server 输出格式兼容 R2/S3，前端可以统一消费。

### AList（推荐用于 NAS）

[AList](https://github.com/alist-org/alist) 是一个文件管理器，可以将本地目录挂载为 WebDAV/HTTP 服务：

1. 安装 AList 并添加本地存储
2. 将下载目录挂载到 `/instagram` 路径
3. API Server 生成的直链指向 AList：`https://your-alist.com/d/instagram/username/stories/20260311/file.jpg`

```env
# API Server 环境变量
ALIST_BASE=http://localhost:5244
ALIST_PUBLIC=https://your-alist-domain.com
```

### Cloudflare R2 / AWS S3

如果需要云存储，可以将下载的文件同步到 R2/S3：

```bash
# 使用 rclone 同步到 R2
rclone sync ./downloads r2:your-bucket/media/ --progress

# 或 AWS S3
rclone sync ./downloads s3:your-bucket/media/ --progress
```

配合 Cloudflare Worker 或 S3 静态网站托管，可以直接提供文件访问。

**R2 配置示例：**
```toml
# rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = YOUR_ACCESS_KEY
secret_access_key = YOUR_SECRET_KEY
endpoint = https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
```

### 存储方案对比

| 方案 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **本地 + AList** | NAS / 家庭服务器 | 零成本、简单 | 需要内网穿透或 VPN |
| **Cloudflare R2** | 公网访问 | 免费 10GB、CDN 加速 | 需要域名和配置 |
| **AWS S3** | 企业级 | 高可用、丰富生态 | 按量付费 |
| **本地 + API Server** | 开发测试 | 最简单、即开即用 | 仅限本地网络 |

## 致谢

- [**Neo**](https://github.com/4ier/neo) by [@4ier](https://github.com/4ier) — 将任何网站转化为 AI 可调用的 API。本项目依赖 Neo 的 CDP `eval` 和 `connect` 命令，通过已认证的浏览器会话与 Instagram 私有 API 交互。

## License

MIT
