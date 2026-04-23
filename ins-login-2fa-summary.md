# Instagram Private API 登录 + 2FA 总结

## 当前状态

**✅ 登录成功！Session已恢复！** 使用备份码 + instagrapi one-shot模式完成2FA登录，cookies已注入Chrome CDP，API测试返回200。

## 已完成的工作

### 1. 服务器脚本（已部署）
- `/vol1/ins-neo-fetcher/scripts/private_api_login.py` — 登录+2FA+cookie提取
- `/vol1/ins-neo-fetcher/scripts/inject_cookies.js` — 注入cookies到Chrome CDP
- `/vol1/ins-neo-fetcher/scripts/session_manager.sh` — 编排监控+登录+注入

### 2. 使用方法

```bash
ssh -p 619 srzwyuu@192.168.3.11
cd /vol1/ins-neo-fetcher

# 检查session状态
./scripts/session_manager.sh status

# 用备份码登录（一条命令搞定：登录+提取cookies+注入CDP）
./scripts/session_manager.sh login-backup <8位备份码>

# 或者分步执行
./venv/bin/python3 scripts/private_api_login.py --code "XXXX XXXX" --backup
node scripts/inject_cookies.js

# 强制恢复（无2FA时直接登录）
./scripts/session_manager.sh force-login
```

### 3. 剩余备份码
已使用3个(~~85794316~~, ~~34912876~~, ~~24693087~~, ~~39587061~~)，剩余:
- `6401 8237`
> ⚠️ 只剩1个备份码！请尽快在Instagram设置中**生成新备份码**或**改用TOTP**。

## 关键技术发现

### Bug 1: `username`必须用IG用户名，不能用email
`accounts/two_factor_login/`端点的`username`参数必须是Instagram真实用户名(`yamasidasitsuki`)，不能是登录email(`srzwyuu1@gmail.com`)。用email会返回`Invalid Parameters`。

**解决**: 从2FA响应的`two_factor_info.username`字段提取真实用户名。

### Bug 2: `instagram_private_api`的`_call_api`对HTTP 400总是抛异常
`return_response=True`只对成功响应(2xx)有效。2FA的400响应走`ErrorHandler.process`→抛`ClientError`。

**解决**: 子类化`Client`，在`login()`中catch `ClientError`，从`error_response`属性提取2FA JSON。

### Bug 3: cookie_jar无法JSON序列化
`instagram_private_api`的cookie_jar用pickle，存入JSON后损坏，无法反序列化。

**解决**: 使用`instagrapi`的one-shot模式（同一进程内完成login+2FA），避免序列化。

### Bug 4: `instagrapi`的`cl.private.cookies`是`RequestsCookieJar`
不能用`.jar`属性，直接迭代即可。

### SMS限流
多次触发`accounts/login/`后，Instagram会限流SMS投递。API返回`two_factor_required`但不实际发送SMS。

## 推荐后续改进

### 改用TOTP（强烈推荐，永久解决2FA问题）
1. Instagram App → 设置 → 安全 → 双重验证 → Authentication App
2. 获取Secret Key
3. 脚本中用`pyotp`自动生成验证码：
```python
import pyotp
totp = pyotp.TOTP("你的SECRET_KEY")
code = totp.now()
```
这样session_manager可以全自动恢复，无需人工干预。

## 服务器信息
- **地址**: `192.168.3.11:619` (Tailscale: `100.64.168.81:619`)
- **用户**: `srzwyuu` / `xjj20000908`
- **Neo Fetcher**: `/vol1/ins-neo-fetcher`
- **Chrome CDP端口**: 9222
- **IG账号**: `srzwyuu1@gmail.com` / IG用户名: `yamasidasitsuki`
