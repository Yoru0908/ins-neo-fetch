#!/usr/bin/env python3
"""
Instagram Archive Local API Server
扫描本地 /vol1/ins-downloads/ 生成 R2 兼容的 JSON，
媒体直链指向 AList。
"""
import os
import io
import json
import hashlib
import time
import threading
from pathlib import Path
from datetime import datetime
from flask import Flask, jsonify, request, send_file, Response
from flask_cors import CORS
from PIL import Image

# ─── 配置 ──────────────────────────────────────────
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/vol1/ins-downloads"))
ALIST_BASE = os.environ.get("ALIST_BASE", "http://192.168.3.11:5244")
ALIST_PUBLIC = os.environ.get("ALIST_PUBLIC", "http://192.168.3.11:5244")  # 前端可访问的 AList 地址
ALIST_MOUNT = "/instagram"  # AList 挂载路径
PORT = int(os.environ.get("API_PORT", "8082"))
ACCOUNTS_FILE = Path(__file__).parent / "accounts.json"
CACHE_DIR = Path(__file__).parent / "cache"
THUMB_DIR = Path(__file__).parent / "thumbs"
THUMB_DIR.mkdir(parents=True, exist_ok=True)

# ─── Flask ─────────────────────────────────────────
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ─── 缓存 ──────────────────────────────────────────
_file_list_cache = None
_cache_time = 0
CACHE_TTL = 300  # 5分钟

# ─── Dedup DB (精确时间戳) ────────────────────────
_dedup_lookup = {}   # filename -> ISO date string
_dedup_load_time = 0

def _load_dedup_lookup():
    """从 dedup_database.json 加载 filename->date 映射，用于精确 PublishTime"""
    global _dedup_lookup, _dedup_load_time
    now = time.time()
    if _dedup_lookup and (now - _dedup_load_time) < CACHE_TTL:
        return _dedup_lookup
    dedup_path = DOWNLOAD_DIR / "dedup_database.json"
    if not dedup_path.exists():
        return _dedup_lookup
    try:
        with open(dedup_path, "r") as f:
            db = json.load(f)
        lookup = {}
        for username, records in db.get("content", {}).items():
            for r in records:
                fn = r.get("filename", "")
                dt = r.get("date", "")
                if fn and dt:
                    lookup[fn] = dt
        _dedup_lookup = lookup
        _dedup_load_time = now
    except Exception as e:
        print(f"[Dedup] Failed to load lookup: {e}")
    return _dedup_lookup


# ═══════════════════════════════════════════════════
#  扫描本地文件，生成 R2 兼容的 file-list.json
# ═══════════════════════════════════════════════════

def scan_downloads() -> dict:
    """扫描 DOWNLOAD_DIR，生成和 R2 file-list.json 相同格式的数据"""
    global _file_list_cache, _cache_time

    now = time.time()
    if _file_list_cache and (now - _cache_time) < CACHE_TTL:
        return _file_list_cache

    files = []
    if not DOWNLOAD_DIR.exists():
        return {"generated_at": datetime.now().isoformat(), "total_files": 0, "files": []}

    for filepath in DOWNLOAD_DIR.rglob("*"):
        if not filepath.is_file():
            continue
        if filepath.name.startswith("."):
            continue

        # 相对路径: username/content_type/date/filename
        rel = filepath.relative_to(DOWNLOAD_DIR)
        parts = rel.parts  # ('username', 'stories|posts', 'YYYYMMDD', 'file.jpg')

        if len(parts) < 3:
            continue

        username = parts[0]
        content_type = parts[1] if len(parts) >= 2 else ""
        date_folder = parts[2] if len(parts) >= 3 else ""
        filename = parts[-1]

        # R2 格式的 Key: media/username/content_type/date/filename
        key = f"media/{'/'.join(parts)}"

        stat = filepath.stat()

        # PublishTime: 优先从 dedup DB 读精确发布时间(taken_at)，fallback 仅用文件夹日期
        dedup = _load_dedup_lookup()
        publish_time = None
        if filename in dedup:
            publish_time = dedup[filename]
        elif len(date_folder) == 8 and date_folder.isdigit():
            publish_time = f"{date_folder[:4]}-{date_folder[4:6]}-{date_folder[6:8]}T00:00:00"

        files.append({
            "Key": key,
            "Size": stat.st_size,
            "LastModified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "ETag": hashlib.md5(key.encode()).hexdigest(),
            "PublishTime": publish_time,
            # AList 直链
            "AlistUrl": f"{ALIST_PUBLIC}/d{ALIST_MOUNT}/{'/'.join(parts)}",
        })

    # 按 Key 排序
    files.sort(key=lambda f: f["Key"])

    result = {
        "generated_at": datetime.now().isoformat(),
        "total_files": len(files),
        "bucket": "local",
        "source": "alist",
        "alist_base": ALIST_PUBLIC,
        "alist_mount": ALIST_MOUNT,
        "target_accounts": [],
        "files": files,
    }

    _file_list_cache = result
    _cache_time = now

    return result


def generate_index() -> dict:
    """生成 R2 兼容的 meta/index.json"""
    file_list = scan_downloads()
    accounts_data = {}

    for f in file_list["files"]:
        parts = f["Key"].split("/")
        if len(parts) < 4 or parts[0] != "media":
            continue
        username = parts[1]
        content_type = parts[2]
        date_str = parts[3] if len(parts) > 3 else ""
        month = f"{date_str[:4]}-{date_str[4:6]}" if len(date_str) >= 6 else ""

        if username not in accounts_data:
            accounts_data[username] = {"total_files": 0, "months": set(), "types": set()}
        accounts_data[username]["total_files"] += 1
        if month:
            accounts_data[username]["months"].add(month)
        if content_type:
            accounts_data[username]["types"].add(content_type)

    accounts = []
    for uname, data in sorted(accounts_data.items()):
        accounts.append({
            "username": uname,
            "total_files": data["total_files"],
            "months": sorted(data["months"], reverse=True),
            "content_types": sorted(data["types"]),
            "last_update": datetime.now().isoformat(),
        })

    return {
        "version": "3.0",
        "generated_at": datetime.now().isoformat(),
        "source": "local-alist",
        "accounts": accounts,
        "stats": {
            "total_accounts": len(accounts),
            "total_files": file_list["total_files"],
            "latest_update": datetime.now().isoformat(),
        },
    }


def generate_account_month(username: str, month: str) -> dict:
    """生成 R2 兼容的 accounts/username/YYYY-MM.json"""
    file_list = scan_downloads()
    files = []

    for f in file_list["files"]:
        parts = f["Key"].split("/")
        if len(parts) < 5 or parts[0] != "media":
            continue
        if parts[1] != username:
            continue
        date_str = parts[3]
        file_month = f"{date_str[:4]}-{date_str[4:6]}" if len(date_str) >= 6 else ""
        if file_month != month:
            continue
        files.append({
            "key": f["Key"],
            "type": parts[2],
            "date": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}" if len(date_str) >= 8 else "",
            "size": f["Size"],
            "filename": parts[-1],
            "alist_url": f["AlistUrl"],
        })

    return {
        "username": username,
        "month": month,
        "updated": datetime.now().isoformat(),
        "total_files": len(files),
        "files": files,
    }


# ═══════════════════════════════════════════════════
#  自动写入 JSON 文件到 AList 挂载目录
# ═══════════════════════════════════════════════════

def write_json_cache():
    """将生成的 JSON 写入本地缓存目录（供 AList 直接提供）"""
    CACHE_DIR.mkdir(exist_ok=True)
    meta_dir = CACHE_DIR / "meta"
    meta_dir.mkdir(exist_ok=True)

    # file-list.json
    fl = scan_downloads()
    with open(meta_dir / "file-list.json", "w") as f:
        json.dump(fl, f, ensure_ascii=False)

    # index.json
    idx = generate_index()
    with open(meta_dir / "index.json", "w") as f:
        json.dump(idx, f, ensure_ascii=False)

    # accounts/username/month.json
    accounts_dir = CACHE_DIR / "accounts"
    for acc in idx["accounts"]:
        udir = accounts_dir / acc["username"]
        udir.mkdir(parents=True, exist_ok=True)
        for month in acc["months"]:
            data = generate_account_month(acc["username"], month)
            with open(udir / f"{month}.json", "w") as f:
                json.dump(data, f, ensure_ascii=False)

    print(f"[{datetime.now().strftime('%H:%M:%S')}] JSON 缓存已更新: "
          f"{idx['stats']['total_accounts']} 账号, {idx['stats']['total_files']} 文件")


def periodic_cache_update():
    """定时更新 JSON 缓存"""
    while True:
        try:
            write_json_cache()
        except Exception as e:
            print(f"缓存更新失败: {e}")
        time.sleep(CACHE_TTL)


# ═══════════════════════════════════════════════════
#  API 路由
# ═══════════════════════════════════════════════════

@app.route("/")
def index():
    return jsonify({"name": "Instagram Archive Local API", "version": "2.0.0", "source": "alist", "status": "running"})


@app.route("/api/status")
def status():
    return jsonify({
        "status": "running",
        "source": "local-alist",
        "alist_base": ALIST_PUBLIC,
        "download_dir": str(DOWNLOAD_DIR),
        "timestamp": datetime.now().isoformat(),
    })


@app.route("/api/file-list")
@app.route("/api/file-list.json")
@app.route("/meta/file-list.json")
def api_file_list():
    """R2 兼容: file-list.json"""
    force = request.args.get("refresh", "").lower() in ("true", "1")
    if force:
        global _file_list_cache, _cache_time
        _file_list_cache = None
        _cache_time = 0
    return jsonify(scan_downloads())


@app.route("/api/index")
@app.route("/api/index.json")
@app.route("/meta/index.json")
def api_index():
    """R2 兼容: meta/index.json"""
    return jsonify(generate_index())


@app.route("/api/accounts/<username>/<month>.json")
@app.route("/accounts/<username>/<month>.json")
def api_account_month(username, month):
    """R2 兼容: accounts/username/YYYY-MM.json"""
    return jsonify(generate_account_month(username, month))


@app.route("/api/accounts")
def api_accounts_list():
    """返回所有账号列表"""
    idx = generate_index()
    return jsonify({"accounts": idx["accounts"], "total": idx["stats"]["total_accounts"]})


@app.route("/api/accounts/<username>")
def api_account_detail(username):
    """返回单个账号的详情"""
    idx = generate_index()
    for acc in idx["accounts"]:
        if acc["username"] == username:
            return jsonify(acc)
    return jsonify({"error": "account not found"}), 404


@app.route("/api/media")
def api_media():
    """前端分页 API: /api/media?page=1&limit=32&account=xxx&type=all&sort=publish_time&order=desc"""
    page = int(request.args.get("page", 1))
    limit = int(request.args.get("limit", 32))
    account = request.args.get("account", None)
    content_type = request.args.get("type", "all")
    sort_by = request.args.get("sort", "publish_time")
    order = request.args.get("order", "desc")

    fl = scan_downloads()
    files = fl["files"]

    # 按账号筛选
    if account:
        files = [f for f in files if f["Key"].split("/")[1].lower() == account.lower()]

    # 按类型筛选
    if content_type and content_type != "all":
        files = [f for f in files if f"/{content_type}/" in f["Key"]]

    # 排序
    if sort_by == "publish_time":
        files.sort(key=lambda f: f.get("PublishTime") or f.get("LastModified") or "", reverse=(order == "desc"))
    elif sort_by == "size":
        files.sort(key=lambda f: f.get("Size", 0), reverse=(order == "desc"))
    elif sort_by == "name":
        files.sort(key=lambda f: f.get("Key", ""), reverse=(order == "desc"))
    else:
        files.sort(key=lambda f: f.get("LastModified") or "", reverse=(order == "desc"))

    # 分页
    total = len(files)
    total_pages = max(1, (total + limit - 1) // limit)
    start = (page - 1) * limit
    end = start + limit
    items = files[start:end]

    return jsonify({
        "success": True,
        "data": {
            "items": items,
            "pagination": {
                "total": total,
                "page": page,
                "limit": limit,
                "total_pages": total_pages,
                "has_more": page < total_pages
            }
        }
    })


@app.route("/api/thumb/<path:key>")
def api_thumb(key):
    """生成并缓存缩略图（默认 400px 宽）"""
    width = int(request.args.get("w", 400))
    width = min(width, 800)  # 最大 800px

    # key 可能以 media/ 开头
    clean = key[6:] if key.startswith("media/") else key
    filepath = DOWNLOAD_DIR / clean

    if not filepath.exists() or not filepath.is_file():
        return jsonify({"error": "file not found"}), 404

    # 视频文件返回占位图
    if filepath.suffix.lower() in (".mp4", ".mov", ".avi"):
        return send_file(filepath, mimetype="video/mp4")

    # 缓存路径
    thumb_hash = hashlib.md5(f"{clean}_{width}".encode()).hexdigest()
    thumb_path = THUMB_DIR / f"{thumb_hash}.jpg"

    if thumb_path.exists():
        return send_file(thumb_path, mimetype="image/jpeg")

    try:
        img = Image.open(filepath)
        # 保持宽高比
        ratio = width / img.width
        new_h = int(img.height * ratio)
        img = img.resize((width, new_h), Image.LANCZOS)
        # 转 RGB（处理 RGBA/P 模式）
        if img.mode not in ("RGB",):
            img = img.convert("RGB")
        img.save(thumb_path, "JPEG", quality=80, optimize=True)
        img.close()
        return send_file(thumb_path, mimetype="image/jpeg")
    except Exception as e:
        # 回退：返回原图
        return send_file(filepath)


@app.route("/api/media/<path:key>")
def api_media_proxy(key):
    """代理访问本地文件（如果前端需要直接 API 访问）"""
    # key: username/content_type/date/filename
    filepath = DOWNLOAD_DIR / key
    if filepath.exists() and filepath.is_file():
        return send_file(filepath)
    return jsonify({"error": "file not found"}), 404


@app.route("/api/stats")
def api_stats():
    """系统统计"""
    fl = scan_downloads()
    idx = generate_index()

    # 计算总大小
    total_size = sum(f["Size"] for f in fl["files"])
    stories = sum(1 for f in fl["files"] if "/stories/" in f["Key"])
    posts = sum(1 for f in fl["files"] if "/posts/" in f["Key"])

    return jsonify({
        "total_accounts": idx["stats"]["total_accounts"],
        "total_files": fl["total_files"],
        "total_size_mb": round(total_size / 1024 / 1024, 1),
        "stories_count": stories,
        "posts_count": posts,
        "alist_url": f"{ALIST_PUBLIC}/d{ALIST_MOUNT}",
        "generated_at": datetime.now().isoformat(),
    })


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    """强制刷新缓存"""
    global _file_list_cache, _cache_time
    _file_list_cache = None
    _cache_time = 0
    write_json_cache()
    return jsonify({"status": "refreshed", "timestamp": datetime.now().isoformat()})


@app.route("/api/download-batch", methods=["POST"])
def api_download_batch():
    """批量下载：将指定账号的文件打包为 ZIP 流式返回"""
    import zipfile as zf

    data = request.get_json(force=True)
    username = data.get("username")
    content_types = data.get("content_types", ["posts", "stories"])
    file_types = data.get("file_types", ["video", "image"])

    if not username:
        return jsonify({"error": "username is required"}), 400

    fl = scan_downloads()
    matched = []

    # 图片/视频扩展名
    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"}
    video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

    for f in fl["files"]:
        parts = f["Key"].split("/")
        if len(parts) < 5 or parts[0] != "media":
            continue
        if parts[1].lower() != username.lower():
            continue
        ct = parts[2]  # posts / stories
        if ct not in content_types:
            continue
        ext = Path(parts[-1]).suffix.lower()
        if "image" in file_types and ext in image_exts:
            matched.append(f)
        elif "video" in file_types and ext in video_exts:
            matched.append(f)

    if not matched:
        return jsonify({"error": "no matching files"}), 404

    def generate_zip():
        buf = io.BytesIO()
        with zf.ZipFile(buf, "w", zf.ZIP_STORED) as z:
            for f in matched:
                key = f["Key"]
                clean = key[6:] if key.startswith("media/") else key
                filepath = DOWNLOAD_DIR / clean
                if filepath.exists() and filepath.is_file():
                    arcname = str(Path(clean).relative_to(username)) if clean.startswith(username) else clean
                    z.write(filepath, arcname)
        buf.seek(0)
        return buf

    try:
        zip_buf = generate_zip()
        return send_file(
            zip_buf,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{username}_batch.zip"
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════════════
#  启动
# ═══════════════════════════════════════════════════

if __name__ == "__main__":
    print(f"Instagram Archive Local API")
    print(f"  下载目录: {DOWNLOAD_DIR}")
    print(f"  AList: {ALIST_PUBLIC}")
    print(f"  端口: {PORT}")

    # 启动定时缓存更新线程
    cache_thread = threading.Thread(target=periodic_cache_update, daemon=True)
    cache_thread.start()

    app.run(host="0.0.0.0", port=PORT, debug=False)
