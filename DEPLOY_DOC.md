# 坂道 Instagram 抓取系统 — 私有运维文档

> 本文档为个人部署专用，包含服务器凭证和完整配置信息。**请勿公开。**

## 架构概览

```
┌─────────────────────────────────────────────────┐
│  Homeserver (Synology NAS / Debian 12)          │
│  IP: 192.168.3.11 | SSH: 端口 619               │
│                                                 │
│  ┌──────────┐   CDP    ┌──────────┐             │
│  │ Chromium  │◄────────►│ Neo CLI  │             │
│  │ (Xvfb:99)│  :9222   │ @4ier/neo│             │
│  └──────────┘          └────┬─────┘             │
│       │                     │                   │
│       │ Instagram 登录态     │ neo eval          │
│       │                     │                   │
│  ┌────▼─────────────────────▼────┐              │
│  │     ins-neo-fetcher           │              │
│  │  /vol1/ins-neo-fetcher        │              │
│  │  Node.js (stories + posts)    │              │
│  └──────────────┬────────────────┘              │
│                 │                               │
│  ┌──────────────▼────────────────┐              │
│  │  /vol1/ins-downloads          │              │
│  │  username/stories|posts/date/ │              │
│  └──────────────┬────────────────┘              │
│                 │                               │
│  ┌──────────────▼────────────────┐              │
│  │  API Server (Flask :8082)     │              │
│  │  扫描文件 → JSON file-list    │              │
│  └──────────────┬────────────────┘              │
│                 │                               │
│  ┌──────────────▼────────────────┐              │
│  │  AList (:5244)                │              │
│  │  挂载 /instagram → 媒体直链    │              │
│  └──────────────────────────────┘              │
└─────────────────────────────────────────────────┘
         │
         ▼ 公网访问
   https://alist.sakamichi-tools.cn
```

## 服务器信息

| 项目 | 值 |
|------|-----|
| IP | `192.168.3.11` |
| SSH 端口 | `619` |
| 用户名 | `srzwyuu` |
| 密码 | `xjj20000908` |
| sudo | `echo 'xjj20000908' \| sudo -S <cmd>` |
| OS | Debian 12 (bookworm) |
| Node.js | v22.18.0 (`/vol1/@appcenter/nodejs_v22/bin/`) |

### SSH 连接

```bash
ssh -p 619 srzwyuu@192.168.3.11
```

## 目录结构

```
/vol1/ins-neo-fetcher/          # 主程序
├── dist/                       # 编译后的 JS
├── scripts/
│   ├── ins-neo-fetcher.sh      # Cron 调用的抓取脚本
│   └── ins-neo-start-chrome.sh # Chrome 启动脚本
├── logs/
│   ├── fetcher.log             # 抓取日志
│   ├── chrome.log              # Chrome 日志
│   └── cron.log                # Cron 执行日志
├── chrome-profile/             # Chrome 登录态（持久化）
├── .env                        # 运行配置
├── package.json
└── node_modules/

/vol1/ins-downloads/            # 下载目录
├── miichan_official/
│   ├── stories/20260311/
│   └── posts/20260301/
├── _yui_kobayashi/
│   └── ...
└── dedup_database.json         # 去重数据库
```

## 账号配置

### Instagram 登录账号
- **邮箱**: `srzwyuu1@gmail.com`
- **密码**: `Xjj20000908!`

### 目标账号（25 个）

```
miichan_official, _yui_kobayashi, fuustagram215,
takemotoyui_official, rena_moriya_official, akiho_onuma_official,
fujiyoshi.karin, yamasaki.ten, yuzuki_nakashima_official,
reinaodakura_official, airi.taniguchi.official, yu.murai_official,
ozonoreis2, rika.ishimori.official, sakurazaka46_info_official,
sakurazaka46jp, habuchaan, seki_yumiko_official,
yuuka_sugai_official, harada_aoi_, _risawatanabe_,
watanabe.rika.official, akane.moriya_official,
riko_matsudaira_official, nerunagahama_
```

## 服务管理

### 当前运行的服务

| 服务 | 类型 | 说明 |
|------|------|------|
| Xvfb :99 | 进程 | 虚拟显示器 |
| Chromium (CDP :9222) | 进程 | 浏览器 + Instagram 登录态 |
| Neo CLI | 连接 | CDP 桥接 |
| ins-api-server.service | systemd | Flask API Server (端口 8082) |
| Cron: ins-neo-fetcher | crontab | 每 4 小时抓取 |
| Cron: @reboot chrome | crontab | 开机自启 Chrome |

### 定时任务

```bash
# 查看当前 crontab
crontab -l

# Instagram Neo Fetcher - every 4 hours
0 */4 * * * /vol1/ins-neo-fetcher/scripts/ins-neo-fetcher.sh >> /vol1/ins-neo-fetcher/logs/cron.log 2>&1

# Auto-start Chrome+Xvfb on reboot
@reboot sleep 30 && /vol1/ins-neo-fetcher/scripts/ins-neo-start-chrome.sh >> /vol1/ins-neo-fetcher/logs/chrome-boot.log 2>&1
```

### API Server 管理

```bash
# 状态
echo 'xjj20000908' | sudo -S systemctl status ins-api-server.service

# 重启（刷新文件列表缓存）
echo 'xjj20000908' | sudo -S systemctl restart ins-api-server.service

# 查看日志
tail -f /home/srzwyuu/ins-playwright-fetcher/logs/api.log
```

> **注意**：API Server 有 5 分钟缓存，新文件下载后最多等 5 分钟或手动重启服务才会在前端出现。

## 常用运维操作

### 手动执行一次抓取

```bash
export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH"
cd /vol1/ins-neo-fetcher
node dist/index.js
```

### 检查 Neo/Chrome 状态

```bash
export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH"

# 检查 Chrome 是否运行
pgrep -f 'remote-debugging-port=9222'

# 检查 CDP 端口是否响应
curl -s http://localhost:9222/json/version | head -3

# 检查 Neo 连接
neo tab
```

### Chrome/Neo 重启

```bash
export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH"
export DISPLAY=:99

# 启动 Xvfb（如果没运行）
pgrep -f 'Xvfb :99' || (Xvfb :99 -screen 0 1920x1080x24 & sleep 2)

# 启动 Chrome
chromium --remote-debugging-port=9222 \
    --user-data-dir=/vol1/ins-neo-fetcher/chrome-profile \
    --no-first-run --no-sandbox --disable-dev-shm-usage \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    'https://www.instagram.com/' \
    > /vol1/ins-neo-fetcher/logs/chrome.log 2>&1 &

sleep 5
neo connect 9222
```

### Instagram 重新登录

当 Instagram 会话过期时（通常几个月），需要重新登录：

```bash
# 在本地 Mac 终端执行
ssh -p 619 -L 9222:localhost:9222 srzwyuu@192.168.3.11

# 然后在本地 Chrome 打开：
# chrome://inspect/#devices
# 点击 Instagram 标签页的 "inspect"
# 在 DevTools 窗口中重新登录 Instagram
```

### 添加/删除目标账号

编辑服务器上的 `.env` 文件：

```bash
vi /vol1/ins-neo-fetcher/.env
# 修改 TARGET_ACCOUNTS=account1,account2,...
```

### 查看去重数据库

```bash
# 统计
cat /vol1/ins-downloads/dedup_database.json | python3 -c "
import json,sys
db=json.load(sys.stdin)
print(f'Total: {db[\"statistics\"][\"total_content\"]}')
print(f'Stories: {db[\"statistics\"][\"stories_count\"]}')
print(f'Posts: {db[\"statistics\"][\"posts_count\"]}')
print(f'Accounts: {len(db[\"content\"])}')
"

# 完整查看
cat /vol1/ins-downloads/dedup_database.json | python3 -m json.tool | less
```

### 查看抓取日志

```bash
# 最近的 cron 日志
tail -50 /vol1/ins-neo-fetcher/logs/cron.log

# 最近的 fetcher 日志
tail -50 /vol1/ins-neo-fetcher/logs/fetcher.log

# 实时查看
tail -f /vol1/ins-neo-fetcher/logs/fetcher.log
```

## 部署更新流程

在本地修改代码后部署到服务器：

```bash
# 1. 本地构建
cd /path/to/ins-neo-fetcher
npm run build

# 2. 上传到服务器
scp -P 619 -r dist srzwyuu@192.168.3.11:/vol1/ins-neo-fetcher/

# 3. 如果修改了 package.json，也要同步并重装依赖
scp -P 619 package.json package-lock.json srzwyuu@192.168.3.11:/vol1/ins-neo-fetcher/
ssh -p 619 srzwyuu@192.168.3.11 "cd /vol1/ins-neo-fetcher && npm install --omit=dev"
```

## 性能数据

| 指标 | 值 |
|------|-----|
| 全量抓取 25 账号（stories + posts） | ~3 分 19 秒 |
| 仅 stories（无新 posts） | ~33 秒 |
| 去重后重复运行 | ~30 秒 |
| Chrome 常驻内存 | ~200MB |
| 下载目录大小（初始） | ~50MB（20 stories + 804 posts 媒体） |

## 故障排查

### 抓取返回 0 条结果

1. 检查 Neo 是否连接：`neo tab`
2. 如果返回 `Error: fetch failed`，重新连接：`neo connect 9222`
3. 如果 CDP 端口无响应，重启 Chrome（见上方操作）
4. 检查 Instagram 登录态是否过期（打开 DevTools 看是否被跳转到登录页）

### 前端显示 "Failed to fetch"

1. 检查 API Server 是否运行：`sudo systemctl status ins-api-server.service`
2. 重启 API Server：`sudo systemctl restart ins-api-server.service`
3. 等待 5 秒后刷新前端

### Chrome 无法启动

1. 检查 Xvfb：`pgrep -f 'Xvfb :99'`
2. 检查端口占用：`ss -tlnp | grep 9222`
3. 检查 Chrome 日志：`cat /vol1/ins-neo-fetcher/logs/chrome.log`

### 磁盘空间

```bash
# 下载目录大小
du -sh /vol1/ins-downloads/

# vol1 剩余空间
df -h /vol1/
```

## 备份

本地备份位置：
- **源代码**: `/Users/yoru/Documents/SA/项目/sakamichi-tools/坂道Instagram/`
- **Playwright 旧版本**: `/Users/yoru/Documents/SA/项目/sakamichi-tools/INS/ins-homeserver版/ins-playwright-fetcher/`
- **开源仓库**: `https://github.com/Yoru0908/ins-neo-fetch`

## 历史变更

| 日期 | 变更 |
|------|------|
| 2026-03-11 | 从 Playwright 版本迁移到 Neo 版本 |
| 2026-03-11 | 实现 JSON 去重数据库 |
| 2026-03-11 | 添加 Posts 抓取功能（含轮播/分页） |
| 2026-03-11 | Cron 定时每 4 小时，Chrome @reboot 自启 |
| 2026-03-11 | 开源到 GitHub (ins-neo-fetch) |
| 2026-04-03 | `--fast` 模式延迟从 3s → 20-35s 随机，减少 Instagram session 失效 |
| 2026-04-03 | 主循环加入 shuffle + 随机延迟（60-150s），Cron 改为 6h/组 2h 错开 |
| 2026-04-03 | Posts early-stop 优化：前 5 条已知即跳过剩余分页 |
| 2026-04-06 | **🐛 修复 carousel dedup bug**（见下方详细说明） |
| 2026-04-06 | Carousel 补抓：16333 → 20755 records (+4422) |

### 2026-04-06 Carousel Dedup Bug 修复

**问题**：`DedupManager.normalizeId()` 对所有包含 `_` 的 ID 执行 `split('_')[0]`，
原意是去除 Instagram 原生 ID 的 user ID 后缀（如 `3849799_10860886596` → `3849799`），
但同时也错误地砍掉了 carousel index 后缀（如 `3868639_0` → `3868639`）。

**影响**：所有 carousel 帖子（多图/多视频）只下载第 1 张图片，后续图片被误判为已存在而跳过。
从项目上线（2026-03-11）到修复（2026-04-06）期间的所有 carousel 帖子受影响。

**修复**：`dedup.ts` 中新增 `normalizeId()` 方法，仅当 `_` 后缀为大数字（>999，即 Instagram user ID）时才 strip，
保留小数字后缀（carousel index 0, 1, 2...）。`contentExists()` 增加前缀匹配逻辑，
使 early-stop 的 base ID 检查能匹配已存储的 carousel 变体（如 `"123"` 匹配 `"123_0"`）。

**补救**：修复后重跑一次 `--fast` 抓取，自动补下所有之前遗漏的 carousel 图片（+4225 new）。

```typescript
// 修复前（错误）：
const normalizedId = contentId.includes('_') ? contentId.split('_')[0] : contentId;

// 修复后（正确）：
private normalizeId(contentId: string): string {
    if (!contentId.includes('_')) return contentId;
    const parts = contentId.split('_');
    const suffix = Number(parts[parts.length - 1]);
    if (!isNaN(suffix) && suffix > 999) {
        return parts.slice(0, -1).join('_');
    }
    return contentId;
}
```
