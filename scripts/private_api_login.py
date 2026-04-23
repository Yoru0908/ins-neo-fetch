#!/usr/bin/env python3
"""
Instagram Login with 2FA support (instagram_private_api + instagrapi fallback)

核心思路: 子类化Client, 拦截2FA错误, 保留HTTP session state,
         然后用同一个session调 two_factor_login 端点.

两步登录流程 (不会重复触发SMS):
  Step 1: python3 private_api_login.py           → 触发SMS, 保存client state
  Step 2: python3 private_api_login.py --code XX  → 恢复state, 直接调two_factor_login
"""
import os
import sys
import json
import logging
import argparse
import time
from pathlib import Path
from datetime import datetime

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

BASE_DIR = Path("/vol1/ins-neo-fetcher")
COOKIES_FILE = BASE_DIR / "web_cookies.json"
TWO_FACTOR_STATE = BASE_DIR / "2fa_state.json"
BACKUP_CODES_FILE = BASE_DIR / "backup_codes.txt"  # 每行一个备份码
TOTP_SECRET_FILE = BASE_DIR / "totp_secret.txt"    # TOTP secret key
INSTA_USER = os.getenv("INSTA_USER", "srzwyuu1@gmail.com")
INSTA_PASS = os.getenv("INSTA_PASS", "Xjj20000908!")


def get_auto_2fa_code():
    """
    自动获取2FA验证码 (优先TOTP, 其次备份码)
    返回: (code, method, source) 或 (None, None, None)
    """
    # 优先用TOTP
    totp_secret = os.getenv('TOTP_SECRET', '').strip()
    if not totp_secret and TOTP_SECRET_FILE.exists():
        totp_secret = TOTP_SECRET_FILE.read_text().strip()
    if totp_secret:
        try:
            import pyotp
            totp = pyotp.TOTP(totp_secret)
            code = totp.now()
            logger.info(f"[AUTO] TOTP验证码已生成")
            return code, '3', 'totp'  # method=3 for TOTP
        except ImportError:
            logger.warning("[AUTO] pyotp未安装, 无法使用TOTP")
        except Exception as e:
            logger.warning(f"[AUTO] TOTP生成失败: {e}")

    # 其次用备份码
    if BACKUP_CODES_FILE.exists():
        lines = [l.strip().replace(' ', '') for l in BACKUP_CODES_FILE.read_text().splitlines() if l.strip()]
        if lines:
            code = lines[0]
            remaining = lines[1:]
            BACKUP_CODES_FILE.write_text('\n'.join(remaining) + '\n' if remaining else '')
            logger.info(f"[AUTO] 使用备份码 (剩余{len(remaining)}个)")
            if len(remaining) <= 1:
                logger.warning(f"[AUTO] ⚠️ 备份码即将用完! 请尽快生成新备份码或改用TOTP")
            return code, '2', 'backup'  # method=2 for backup codes

    logger.error("[AUTO] 无可用的自动2FA方式 (TOTP/备份码)")
    return None, None, None


# ============================================================
# 方案A: instagram_private_api (子类化, 手动处理2FA)
# ============================================================

def _create_2fa_client_class():
    """创建支持2FA的Client子类"""
    from instagram_private_api import Client, ClientError, ClientLoginError

    class TwoFactorClient(Client):
        """覆写login(), 拦截2FA, 不让__init__抛异常"""
        _2fa_json = None  # 保存2FA响应
        _login_ok = False

        def login(self):
            # Step 1: prelogin (获取csrftoken)
            prelogin_params = self._call_api(
                'si/fetch_headers/', params='',
                query={'challenge_type': 'signup', 'guid': self.generate_uuid(True)},
                return_response=True)
            if not self.csrftoken:
                raise ClientError(
                    'Unable to get csrf from prelogin.',
                    error_response=self._read_response(prelogin_params))

            login_params = {
                'device_id': self.device_id,
                'guid': self.uuid,
                'adid': self.ad_id,
                'phone_id': self.phone_id,
                '_csrftoken': self.csrftoken,
                'username': self.username,
                'password': self.password,
                'login_attempt_count': '0',
            }

            # Step 2: login (HTTP 400 = 2FA required → _call_api raises ClientError)
            try:
                login_response = self._call_api(
                    'accounts/login/', params=login_params, return_response=True)
            except ClientError as e:
                # _call_api对400响应走ErrorHandler.process→抛ClientError
                # 从error_response中提取2FA信息
                error_msg = str(e).lower()
                if 'two_factor_required' in error_msg:
                    logger.info("[PrivateAPI] 检测到2FA (从ClientError)")
                    # error_response可能是str或dict
                    er = getattr(e, 'error_response', '{}')
                    if isinstance(er, str):
                        try:
                            self._2fa_json = json.loads(er)
                        except json.JSONDecodeError:
                            self._2fa_json = {}
                    elif isinstance(er, dict):
                        self._2fa_json = er
                    else:
                        self._2fa_json = {}
                    return  # 不re-raise, 让__init__正常完成
                raise  # 非2FA错误继续抛出

            # Step 3: 正常登录成功
            login_json = json.loads(self._read_response(login_response))

            if login_json.get('two_factor_required'):
                logger.info("[PrivateAPI] 检测到2FA (从response)")
                self._2fa_json = login_json
                return

            if not login_json.get('logged_in_user', {}).get('pk'):
                raise ClientLoginError('Unable to login.')

            self._login_ok = True
            if self.on_login:
                self.on_login(self)

        def complete_2fa(self, code, identifier, real_username=None, verify_method='3'):
            """用验证码完成2FA (使用同一个HTTP session)"""
            params = {
                'two_factor_identifier': identifier,
                'username': real_username or self.username,  # 必须用IG用户名,不能用email
                'verification_code': str(code),
                '_csrftoken': self.csrftoken,
                'device_id': self.device_id,
                'guid': self.uuid,
                'phone_id': self.phone_id,
                'trust_this_device': '1',
                'verification_method': verify_method,
            }
            response = self._call_api(
                'accounts/two_factor_login/', params=params, return_response=True)
            result_json = json.loads(self._read_response(response))
            return result_json

    return TwoFactorClient


def instagrapi_one_shot(code, verify_method='2'):
    """
    单进程: 触发登录 → 立即用备份码/验证码完成2FA
    使用instagrapi (已验证可用), 关键修复:
    - username必须用IG真实用户名(从2FA响应提取), 不能用email
    - verification_method=2 用于备份码, =1 用于SMS
    """
    from instagrapi import Client as IGClient
    from instagrapi.exceptions import TwoFactorRequired
    from uuid import uuid4

    cl = IGClient()
    logger.info(f"[instagrapi] One-shot登录 {INSTA_USER} (code={code}, method={verify_method})")

    try:
        cl.login(INSTA_USER, INSTA_PASS)
        if cl.user_id:
            logger.info(f"[instagrapi] 直接登录成功! user_id={cl.user_id}")
            return cl
        return None
    except TwoFactorRequired:
        pass

    info = cl.last_json.get('two_factor_info', {})
    ident = info.get('two_factor_identifier', '')
    real_username = info.get('username', '')  # 关键: 真实IG用户名

    if not ident or not real_username:
        logger.error(f"[instagrapi] 2FA info不完整: ident={bool(ident)}, user={real_username}")
        return None

    logger.info(f"[instagrapi] 2FA触发, username={real_username}, 立即用验证码完成...")

    data = {
        'verification_code': code,
        'phone_id': cl.phone_id,
        '_csrftoken': cl.token,
        'two_factor_identifier': ident,
        'username': real_username,  # 关键修复: 用IG用户名
        'trust_this_device': '1',
        'guid': cl.uuid,
        'device_id': cl.android_device_id,
        'waterfall_id': str(uuid4()),
        'verification_method': verify_method,
    }

    try:
        result = cl.private_request('accounts/two_factor_login/', data, login=True)
        pk = result.get('logged_in_user', {}).get('pk')
        logger.info(f"[instagrapi] 2FA响应: pk={pk}")

        if cl.last_response:
            auth = cl.last_response.headers.get('ig-set-authorization')
            if auth:
                cl.authorization_data = cl.parse_authorization(auth)

        if pk:
            logger.info(f"[instagrapi] 登录成功!")
            return cl
        else:
            logger.error(f"[instagrapi] 2FA失败: {result.get('message', 'unknown')}")
            return None
    except Exception as e:
        logger.error(f"[instagrapi] 2FA异常: {type(e).__name__}: {e}")
        return None


def private_api_step1():
    """Step 1: 用instagram_private_api触发登录, 保存2FA state"""
    TwoFactorClient = _create_2fa_client_class()

    logger.info(f"[PrivateAPI] Step1: 登录 {INSTA_USER}")
    try:
        api = TwoFactorClient(INSTA_USER, INSTA_PASS)
    except Exception as e:
        logger.error(f"[PrivateAPI] Client创建失败: {type(e).__name__}: {e}")
        return None

    # 情况1: 直接登录成功(无2FA)
    if api._login_ok:
        logger.info("[PrivateAPI] 直接登录成功(无需2FA)")
        return api

    # 情况2: 需要2FA
    if api._2fa_json:
        two_factor_info = api._2fa_json.get('two_factor_info', {})
        identifier = two_factor_info.get('two_factor_identifier', '')
        phone = two_factor_info.get('obfuscated_phone_number', 'unknown')

        if not identifier:
            logger.error(f"[PrivateAPI] 无法获取identifier")
            logger.info(f"2fa_json keys: {list(api._2fa_json.keys())}")
            return None

        logger.info(f"[PrivateAPI] SMS已发送到: {phone}")
        logger.info(f"[PrivateAPI] identifier: {identifier[:20]}...")

        real_username = two_factor_info.get('username', INSTA_USER)
        # 保存完整state: settings (含cookie_jar) + 2FA info
        state = {
            'library': 'instagram_private_api',
            'settings': api.settings,  # 包含uuid, device_id, cookie等
            'two_factor_identifier': identifier,
            'real_username': real_username,
            'two_factor_info': two_factor_info,
            'phone_info': phone,
            'timestamp': datetime.now().isoformat(),
        }
        with open(TWO_FACTOR_STATE, 'w') as f:
            json.dump(state, f, indent=2, default=str)

        logger.info(f"[PrivateAPI] State已保存: {TWO_FACTOR_STATE}")
        logger.info("")
        logger.info("请使用以下命令完成登录:")
        logger.info(f"  python3 {__file__} --code <验证码>")
        return "2FA_PENDING"

    logger.error("[PrivateAPI] 登录状态未知")
    return None


def private_api_step2(code, verify_method="3"):
    """Step 2: 恢复state, 用同一个session完成2FA"""
    from instagram_private_api import Client, ClientError

    if not TWO_FACTOR_STATE.exists():
        logger.error("未找到2FA state文件")
        return None

    with open(TWO_FACTOR_STATE, 'r') as f:
        state = json.load(f)

    if state.get('library') != 'instagram_private_api':
        logger.info("State来自其他library, 尝试instagrapi")
        return instagrapi_step2(code)

    identifier = state['two_factor_identifier']
    real_username = state.get('real_username', INSTA_USER)
    saved_settings = state['settings']

    logger.info(f"[PrivateAPI] Step2: 恢复session + 验证码 {code} (user={real_username})")

    # 用保存的settings恢复Client (跳过login, 恢复cookie_jar)
    try:
        api = Client(INSTA_USER, INSTA_PASS, settings=saved_settings)
    except Exception as e:
        logger.warning(f"[PrivateAPI] Settings恢复异常: {e}")
        return None

    # 直接调用2FA端点
    params = {
        'two_factor_identifier': identifier,
        'username': real_username,
        'verification_code': str(code),
        '_csrftoken': api.csrftoken,
        'device_id': api.device_id,
        'guid': api.uuid,
        'phone_id': api.phone_id,
        'trust_this_device': '0',
        'verification_method': verify_method,
    }

    logger.info(f"[PrivateAPI] 调用 accounts/two_factor_login/ (method={verify_method}) ...")
    try:
        response = api._call_api(
            'accounts/two_factor_login/', params=params, return_response=True)
        result = json.loads(api._read_response(response))
        logger.info(f"[PrivateAPI] 2FA响应: {json.dumps(result)[:300]}")

        if result.get('logged_in_user', {}).get('pk'):
            logger.info("[PrivateAPI] 2FA登录成功!")
            TWO_FACTOR_STATE.unlink(missing_ok=True)
            return api
        else:
            logger.error(f"[PrivateAPI] 2FA失败: {result.get('message', 'unknown')}")
            return None

    except Exception as e:
        logger.error(f"[PrivateAPI] 2FA调用异常: {type(e).__name__}: {e}")
        return None


# ============================================================
# 方案B: instagrapi (备选)
# ============================================================

def instagrapi_step1():
    """用instagrapi触发登录"""
    from instagrapi import Client as IGClient
    from instagrapi.exceptions import TwoFactorRequired, ChallengeRequired

    cl = IGClient()
    logger.info(f"[instagrapi] Step1: 登录 {INSTA_USER}")

    try:
        cl.login(INSTA_USER, INSTA_PASS)
        if cl.user_id:
            logger.info(f"[instagrapi] 直接登录成功! user_id={cl.user_id}")
            return cl
        return None

    except TwoFactorRequired as e:
        logger.info("[instagrapi] 2FA触发成功")
        two_factor_info = cl.last_json.get("two_factor_info", {})
        identifier = two_factor_info.get("two_factor_identifier", "")
        phone = two_factor_info.get("obfuscated_phone_number", "unknown")

        if not identifier:
            logger.error("[instagrapi] 无法获取identifier")
            return None

        logger.info(f"[instagrapi] SMS发送到: {phone}")

        real_username = two_factor_info.get("username", INSTA_USER)
        state = {
            'library': 'instagrapi',
            'settings': cl.get_settings(),
            'two_factor_identifier': identifier,
            'real_username': real_username,
            'phone_info': phone,
            'phone_id': cl.phone_id,
            'uuid': cl.uuid,
            'android_device_id': cl.android_device_id,
            'csrftoken': cl.token,
            'timestamp': datetime.now().isoformat(),
        }
        with open(TWO_FACTOR_STATE, 'w') as f:
            json.dump(state, f, indent=2, default=str)

        logger.info(f"[instagrapi] State已保存")
        logger.info(f"请使用: python3 {__file__} --code <验证码>")
        return "2FA_PENDING"

    except ChallengeRequired as e:
        logger.error(f"[instagrapi] Challenge required: {e}")
        return None
    except Exception as e:
        logger.error(f"[instagrapi] 错误: {type(e).__name__}: {e}")
        return None


def instagrapi_step2(code, verify_method="3"):
    """用instagrapi恢复state完成2FA"""
    from instagrapi import Client as IGClient
    from uuid import uuid4

    if not TWO_FACTOR_STATE.exists():
        return None

    with open(TWO_FACTOR_STATE, 'r') as f:
        state = json.load(f)

    identifier = state.get('two_factor_identifier', '')
    real_username = state.get('real_username', INSTA_USER)
    if not identifier:
        return None

    logger.info(f"[instagrapi] Step2: 恢复state + 验证码 {code} (user={real_username})")

    cl = IGClient()
    cl.set_settings(state['settings'])

    data = {
        "verification_code": code,
        "phone_id": state.get('phone_id', cl.phone_id),
        "_csrftoken": state.get('csrftoken', cl.token),
        "two_factor_identifier": identifier,
        "username": real_username,
        "trust_this_device": "1",
        "guid": state.get('uuid', cl.uuid),
        "device_id": state.get('android_device_id', cl.android_device_id),
        "waterfall_id": str(uuid4()),
        "verification_method": verify_method,
    }

    logger.info(f"[instagrapi] 调用 two_factor_login (method={verify_method}) ...")
    try:
        logged = cl.private_request("accounts/two_factor_login/", data, login=True)
        logger.info(f"[instagrapi] 响应: {json.dumps(logged)[:300] if logged else 'None'}")

        if cl.last_response:
            auth_header = cl.last_response.headers.get("ig-set-authorization")
            if auth_header:
                cl.authorization_data = cl.parse_authorization(auth_header)

        if logged:
            try:
                cl.login_flow()
            except Exception as e:
                logger.warning(f"[instagrapi] login_flow异常(非致命): {e}")
            cl.last_login = time.time()

        if cl.user_id:
            logger.info(f"[instagrapi] 2FA成功! user_id={cl.user_id}")
            TWO_FACTOR_STATE.unlink(missing_ok=True)
            return cl

        return cl if logged else None

    except Exception as e:
        logger.error(f"[instagrapi] 2FA失败: {type(e).__name__}: {e}")
        return None


# ============================================================
# Cookie提取 & Session保存
# ============================================================

def extract_cookies_private_api(api):
    """从instagram_private_api Client提取cookies"""
    cookies = {}
    try:
        for cookie in api.cookie_jar:
            if cookie.name in ('sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur'):
                cookies[cookie.name] = cookie.value
    except Exception as e:
        logger.debug(f"cookie_jar提取: {e}")

    for key in ('sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur'):
        cookies.setdefault(key, '')
    return cookies


def extract_cookies_instagrapi(cl):
    """从instagrapi Client提取cookies"""
    cookies = {}
    # cl.private.cookies 是 RequestsCookieJar, 直接迭代
    try:
        for cookie in cl.private.cookies:
            if cookie.name in ('sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur'):
                cookies[cookie.name] = cookie.value
    except Exception as e:
        logger.debug(f"instagrapi cookies提取: {e}")

    if not cookies.get('sessionid'):
        settings = cl.get_settings()
        auth = settings.get('authorization_data', {})
        cookies['sessionid'] = auth.get('sessionid', '')
        cookies['ds_user_id'] = auth.get('ds_user_id', '')

    for key in ('sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur'):
        cookies.setdefault(key, '')
    return cookies


def save_cookies(cookies, source='unknown'):
    """保存cookies到文件"""
    if not cookies.get('sessionid'):
        logger.error("无sessionid, 不保存")
        return False

    data = {
        'cookies': cookies,
        'timestamp': datetime.now().isoformat(),
        'source': source,
        'username': INSTA_USER
    }
    with open(COOKIES_FILE, 'w') as f:
        json.dump(data, f, indent=2)

    logger.info(f"Cookies已保存: {COOKIES_FILE}")
    logger.info(f"  sessionid: {cookies['sessionid'][:20]}...")
    logger.info(f"  ds_user_id: {cookies.get('ds_user_id', 'N/A')}")
    print(json.dumps(cookies))
    return True


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='Instagram Login with 2FA')
    parser.add_argument('--code', type=str, help='2FA SMS验证码 或 备份码')
    parser.add_argument('--backup', action='store_true', help='使用备份码(verification_method=2)')
    parser.add_argument('--auto', action='store_true', help='自动模式: 自动获取TOTP/备份码完成2FA')
    parser.add_argument('--lib', choices=['private', 'instagrapi', 'auto'],
                       default='auto', help='选择库 (默认: auto=先试private再试instagrapi)')
    args = parser.parse_args()

    # === 自动模式: 自动获取2FA码并完成登录 ===
    if args.auto:
        code, method, source = get_auto_2fa_code()
        if code:
            logger.info(f"[AUTO] 使用{source}验证码, method={method}")
            result = instagrapi_one_shot(code, method)
            if result:
                cookies = extract_cookies_instagrapi(result)
                if save_cookies(cookies, 'instagrapi'):
                    sys.exit(0)
            logger.error(f"[AUTO] {source}登录失败")
            sys.exit(1)
        else:
            logger.error("[AUTO] 无可用的2FA码, 无法自动登录")
            logger.error("  请配置 TOTP: 将secret写入 /vol1/ins-neo-fetcher/totp_secret.txt")
            logger.error("  或添加备份码: 写入 /vol1/ins-neo-fetcher/backup_codes.txt")
            sys.exit(1)

    # === Step 2: 有验证码 → 完成2FA ===
    verify_method = "2" if args.backup else "3"  # 2=备份码, 3=SMS
    if args.code:
        code = args.code.replace(' ', '')  # 去除空格
        logger.info(f"验证码: {code}, 方式: {'备份码' if args.backup else 'SMS'}")

        # 备份码模式: 单进程完成 (用instagrapi, 已验证可用)
        if args.backup:
            result = instagrapi_one_shot(code, verify_method)
            if result:
                cookies = extract_cookies_instagrapi(result)
                if save_cookies(cookies, 'instagrapi'):
                    sys.exit(0)
            logger.error("备份码登录失败")
            sys.exit(1)

        # SMS模式: 从保存的state恢复
        if TWO_FACTOR_STATE.exists():
            with open(TWO_FACTOR_STATE, 'r') as f:
                state = json.load(f)
            lib = state.get('library', 'instagram_private_api')
        else:
            lib = 'instagram_private_api'

        if lib == 'instagram_private_api':
            result = private_api_step2(code, verify_method)
            if result:
                cookies = extract_cookies_private_api(result)
                if save_cookies(cookies, 'instagram_private_api'):
                    sys.exit(0)
        else:
            result = instagrapi_step2(code, verify_method)
            if result:
                cookies = extract_cookies_instagrapi(result)
                if save_cookies(cookies, 'instagrapi'):
                    sys.exit(0)

        logger.error("2FA验证码验证失败")
        sys.exit(1)

    # === Step 1: 触发登录/2FA ===
    use_private = args.lib in ('private', 'auto')
    use_instagrapi = args.lib in ('instagrapi', 'auto')

    if use_private:
        logger.info("=== 尝试 instagram_private_api ===")
        result = private_api_step1()
        if result == "2FA_PENDING":
            sys.exit(2)
        elif result and result != "2FA_PENDING":
            cookies = extract_cookies_private_api(result)
            if save_cookies(cookies, 'instagram_private_api'):
                sys.exit(0)

    if use_instagrapi:
        logger.info("=== 尝试 instagrapi ===")
        result = instagrapi_step1()
        if result == "2FA_PENDING":
            sys.exit(2)
        elif result and result != "2FA_PENDING":
            cookies = extract_cookies_instagrapi(result)
            if save_cookies(cookies, 'instagrapi'):
                sys.exit(0)

    logger.error("所有登录方式均失败")
    sys.exit(1)


if __name__ == "__main__":
    main()
