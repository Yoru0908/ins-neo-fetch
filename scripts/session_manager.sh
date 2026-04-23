#!/bin/bash
# Instagram Session Manager
# 检测401 → Private API登录获取cookies → 注入Chrome CDP → 恢复抓取
# 用法: ./session_manager.sh [check|login|force-login]

set -e
export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH"
export DISPLAY=:99

BASE_DIR="/vol1/ins-neo-fetcher"
SCRIPTS_DIR="$BASE_DIR/scripts"
LOG_DIR="$BASE_DIR/logs"
LOG_FILE="$LOG_DIR/session-manager.log"
VENV="$BASE_DIR/venv/bin/python3"
COOKIES_FILE="$BASE_DIR/web_cookies.json"

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# 检查Instagram API是否正常（通过puppeteer在Chrome中测试）
check_session() {
    log "Checking Instagram session..."
    
    # 确保Chrome CDP运行中
    if ! ss -tlnp | grep -q 9222; then
        log "Chrome CDP not running!"
        return 1
    fi
    
    cd "$BASE_DIR"
    result=$(timeout 30 node -e "
        const puppeteer = require('puppeteer-core');
        (async () => {
            const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
            const pages = await browser.pages();
            const page = pages[0] || await browser.newPage();
            const r = await page.evaluate(async () => {
                try {
                    const res = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram',
                        { headers: { 'x-ig-app-id': '936619743392459' } });
                    return res.status;
                } catch(e) { return 0; }
            });
            console.log(r === 200 ? 'OK' : 'FAIL:' + r);
            browser.disconnect();
        })().catch(e => console.log('FAIL:' + e.message));
    " 2>/dev/null || echo "FAIL:timeout")
    
    if [[ "$result" == "OK" ]]; then
        log "Session OK"
        return 0
    else
        log "Session FAILED: $result"
        return 1
    fi
}

# 用Private API登录获取cookies
# --auto模式: 自动从TOTP/备份码池获取验证码
# 手动模式: 传入备份码
private_api_login() {
    local code="$1"
    log "Running Private API login..."
    cd "$BASE_DIR"
    
    if [ -n "$code" ]; then
        # 手动传入备份码
        $VENV "$SCRIPTS_DIR/private_api_login.py" --code "$code" --backup > /tmp/private_api_output.txt 2>&1
    else
        # 自动模式: 尝试TOTP或备份码池
        $VENV "$SCRIPTS_DIR/private_api_login.py" --auto > /tmp/private_api_output.txt 2>&1
    fi
    exit_code=$?
    
    # 输出日志
    cat /tmp/private_api_output.txt | while read line; do log "  [PY] $line"; done
    
    if [ $exit_code -eq 0 ] && [ -f "$COOKIES_FILE" ]; then
        log "Private API login succeeded, cookies saved"
        return 0
    elif [ $exit_code -eq 2 ]; then
        log "2FA SMS triggered - need verification code"
        log "Run: $0 login-backup <code>"
        return 2
    else
        log "Private API login failed (exit=$exit_code)"
        return 1
    fi
}

# 注入cookies到Chrome CDP
inject_cookies() {
    log "Injecting cookies into Chrome..."
    cd "$BASE_DIR"
    
    result=$(timeout 60 node "$SCRIPTS_DIR/inject_cookies.js" "$COOKIES_FILE" 2>&1)
    exit_code=$?
    
    echo "$result" | while read line; do log "  [JS] $line"; done
    
    if [ $exit_code -eq 0 ]; then
        log "Cookie injection succeeded"
        return 0
    else
        log "Cookie injection failed (exit=$exit_code)"
        return 1
    fi
}

# 完整的session恢复流程
full_recovery() {
    log "=== Starting full session recovery ==="
    
    # Step 1: Private API登录
    if ! private_api_login; then
        log "FATAL: Private API login failed, cannot recover"
        return 1
    fi
    
    # Step 2: 注入cookies
    if ! inject_cookies; then
        log "FATAL: Cookie injection failed"
        return 1
    fi
    
    # Step 3: 验证
    sleep 3
    if check_session; then
        log "=== Session recovery SUCCESS ==="
        return 0
    else
        log "=== Session recovery FAILED (API still not working) ==="
        return 1
    fi
}

# 主逻辑
case "${1:-check}" in
    check)
        if check_session; then
            log "Session is healthy"
            exit 0
        else
            log "Session expired, attempting recovery..."
            full_recovery
            exit $?
        fi
        ;;
    login)
        private_api_login
        exit $?
        ;;
    login-backup)
        # 用备份码登录: session_manager.sh login-backup 85794316
        if [ -z "$2" ]; then
            echo "Usage: $0 login-backup <backup_code>"
            exit 1
        fi
        private_api_login "$2"
        if [ $? -eq 0 ]; then
            inject_cookies
        fi
        exit $?
        ;;
    inject)
        inject_cookies
        exit $?
        ;;
    force-login)
        log "Force login requested"
        full_recovery
        exit $?
        ;;
    status)
        check_session
        exit $?
        ;;
    *)
        echo "Usage: $0 [check|login|login-backup <code>|inject|force-login|status]"
        exit 1
        ;;
esac
