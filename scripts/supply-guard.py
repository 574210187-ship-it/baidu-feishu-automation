# -*- coding: utf-8 -*-
"""
supply-guard.py —— 上游断供哨兵（只读，零飞书 API、零浏览器、零写入）

为什么要这个脚本：
  2026-09-27 实测：百度→飞书链路连续 23 轮空转（三表 fullScanCount=0），
  但既有巡检的 6 条告警条件（exitCode / status / 锁心跳 / 多doc / 三态 / 触发时间）
  全部为绿，于是"上游 5 天没新录屏"这件事被整套巡检体系完全漏掉。
  根因：既有观测全是"执行层指标"（机器在不在转），没有一个指标叫"业务在不在产出"。
  本脚本补的就是这个维度，且刻意做到零 API 成本，可以安全地每小时跑。

判据（三证据链，与技能 §10 一致）：
  A. 最近 N 轮 wrapper 日志的 fullScanCount 是否全为 0（连续空转计数）
  B. 三源表本地文稿目录 mtime 距今
  C. 最近一轮的 exitCode / status（用于区分"断供"与"扫描坏了"）

退出码：0=正常  1=警告(WARN)  2=严重(CRIT)
"""
import os
import re
import sys
import json
import time
import glob
import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = r"D:\百度网盘文稿下载\scheduler\logs"
RUN_DIR = os.path.join(BASE, "state", "runs")
# 三源表本地产物目录（与 config/tables.json 的 anchor 对齐）
DOC_DIRS = {
    "zed": r"D:\百度网盘文稿下载\zed文稿",
    "姜律师": r"D:\百度网盘文稿下载\姜律师文稿",
    "意晨": r"D:\百度网盘文稿下载\意晨文稿",
}

# ---- 阈值 ----
EMPTY_WARN = 6      # 连续空转 >= 6 轮（约 24h）→ 警告
EMPTY_CRIT = 12     # 连续空转 >= 12 轮（约 48h）→ 严重
MTIME_WARN_H = 48   # 文稿目录 mtime 距今 > 48h → 警告
MTIME_CRIT_H = 96   # > 96h → 严重


def latest_logs(n):
    fs = glob.glob(os.path.join(LOG_DIR, "baidu-feishu-batch-*.log"))
    fs.sort(key=os.path.getmtime, reverse=True)
    return fs[:n]


def parse_time(value):
    if not value:
        return 0.0
    text = str(value).strip().replace("/", "-")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.datetime.strptime(text, fmt).timestamp()
        except ValueError:
            pass
    return 0.0


def latest_canonical_runs(n):
    """优先从 run.json 取数，并按批次号去重，避免重复启动被算成多轮。"""
    candidates = []
    for path in glob.glob(os.path.join(RUN_DIR, "*.json")):
        try:
            with open(path, encoding="utf-8") as f:
                run = json.load(f)
        except Exception:
            continue
        if not isinstance(run, dict) or not run.get("batchNo"):
            continue
        scans = []
        for table in run.get("tableResults") or []:
            value = table.get("fullScanCount") if isinstance(table, dict) else None
            if isinstance(value, (int, float)):
                scans.append(int(value))
        status = run.get("status")
        trigger = run.get("trigger") or run.get("mode")
        healthy = status == "complete" and trigger == "scheduled-wrapper-env" and not run.get("stageErrors")
        candidates.append({
            "file": os.path.basename(path),
            "finishedAt": str(run.get("finishedAt") or "").replace("T", " ").replace("Z", ""),
            "exitCode": 0 if healthy else 1,
            "status": status,
            "duration": None,
            "scanCountSlots": len(scans),
            "scans": scans,
            "empty": len(scans) >= 3 and all(v == 0 for v in scans),
            "sizeKB": round(os.path.getsize(path) / 1024, 1),
            "batchNo": run.get("batchNo"),
            "startedAt": str(run.get("startedAt") or ""),
            "healthy": healthy,
        })
    if not candidates:
        return []
    by_batch = {}
    for item in candidates:
        key = item["batchNo"]
        current = by_batch.get(key)
        rank = (0 if item["healthy"] else 1, parse_time(item["startedAt"]))
        if current is None or rank < current[0]:
            by_batch[key] = (rank, item)
    chosen = [item for _, item in by_batch.values()]
    chosen.sort(key=lambda item: parse_time(item["finishedAt"]), reverse=True)
    return chosen[:n]


def parse_round(path):
    """返回 dict: {file, finishedAt, exitCode, status, duration, scans, empty}"""
    try:
        t = io_read(path)
    except Exception as e:
        return {"file": os.path.basename(path), "error": str(e)}

    def g(pat, cast=str):
        m = re.search(pat, t)
        return cast(m.group(1)) if m else None

    scans = [int(x) for x in re.findall(r'fullScanCount"\s*:\s*(\d+)', t)]
    ec = g(r"exitCode\s*=\s*(-?\d+)", int)
    st = g(r"latestRun\s*=\s*\S+\s*/\s*(\w+)")
    du = g(r"durationSeconds\s*=\s*([\d.]+)", float)
    fin = g(r"finishedAt\s*=\s*([\d\- :]+)")
    # 空转判据：6 处 fullScanCount 全部为 0（缺字段时 scans 为空 → 不判空转，避免误报）
    empty = (len(scans) >= 3) and all(v == 0 for v in scans)
    return {
        "file": os.path.basename(path),
        "finishedAt": (fin or "").strip(),
        "exitCode": ec,
        "status": st,
        "duration": du,
        "scanCountSlots": len(scans),
        "scans": scans,
        "empty": empty,
        "sizeKB": round(os.path.getsize(path) / 1024, 1),
    }


def io_read(p):
    for enc in ("utf-8", "gbk", "utf-8-sig"):
        try:
            with open(p, encoding=enc, errors="strict") as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def hours_since(ts):
    return (time.time() - ts) / 3600.0


ALERT_EMIT_DIR = r"D:\winlp_reporter\bin"


def alert_supply(level, alerts, out, machine_ok):
    """把上游断供哨兵的判定送进本机统一故障告警通道（企业微信群05）。

    关键：机器侧异常与「上游无供给」必须分开归因，绝不能笼统报成断供或网络问题。
    只有严重级才提交故障；正常时提交恢复（入口无活动故障会自动忽略，不补发消息）。
    任何异常一律吞掉 —— 哨兵是只读脚本，告警失败不能影响判定与退出码。
    """
    try:
        import sys
        if ALERT_EMIT_DIR not in sys.path:
            sys.path.insert(0, ALERT_EMIT_DIR)
        import alert_emit
    except Exception as e:
        print("告警提交器不可用，跳过统一告警: %r" % (e,))
        return None

    day = datetime.datetime.now().strftime("%Y-%m-%d")
    common = {
        "project-id": "baidu_transcript_03",
        "source": "winlp_batch_listener",
        "component": "baidu_batch",
        "task-id": day,
        "stage": "上游供给哨兵",
        "dedupe-key": "baidu03|supply|%s" % day,
    }
    try:
        if level < 2:
            r = alert_emit.emit_recovered(dict(common, **{
                "error-code": "UPSTREAM_SUPPLY_DRY",
                "severity": "INFO",
                "summary": "%s 上游供给哨兵未发现严重问题，文稿目录持续有更新。" % day,
            }))
            print("统一告警(恢复): %s" % (r.get("decision") or r.get("error")))
            return r
        msgs = [m for s, m in alerts if s == "CRIT"]
        code = "UPSTREAM_SUPPLY_DRY" if machine_ok else "UPSTREAM_LINK_BROKEN"
        r = alert_emit.emit(dict(common, **{
            "error-code": code,
            "severity": "P1",
            "summary": ("上游供给哨兵判定为严重：机器侧=%s，连续空转 %s 轮；共 %d 条，"
                        "前 3 条 —— %s"
                        % ("正常" if machine_ok else "异常",
                           out.get("consecutive_empty_rounds"),
                           len(msgs), " ｜ ".join(msgs[:3])[:300])),
            "next-action": ("机器侧正常则去查录制侧是否在出片；"
                            "机器侧异常先修链路（常见为百度登录态失效，需扫码重登）。"),
        }))
        print("统一告警(故障): %s 通知=%s" % (r.get("decision"), r.get("notify")))
        return r
    except Exception as e:
        print("统一告警提交异常，不影响哨兵判定: %r" % (e,))
        return None


def main():
    rounds = latest_canonical_runs(EMPTY_CRIT + 6)
    if not rounds:
        rounds = [parse_round(p) for p in latest_logs(EMPTY_CRIT + 6)]
    rounds = [r for r in rounds if not r.get("error")]

    # 连续空转计数（从最新往回）
    streak = 0
    for r in rounds:
        if r.get("empty"):
            streak += 1
        else:
            break

    # 文稿目录新鲜度
    doc_age = {}
    for k, d in DOC_DIRS.items():
        if not os.path.isdir(d):
            doc_age[k] = {"exists": False}
            continue
        newest = 0.0
        newest_name = ""
        for root, _, files in os.walk(d):
            for fn in files:
                fp = os.path.join(root, fn)
                try:
                    mt = os.path.getmtime(fp)
                except OSError:
                    continue
                if mt > newest:
                    newest, newest_name = mt, fn
        if newest:
            doc_age[k] = {
                "exists": True,
                "hours": round(hours_since(newest), 1),
                "newest": newest_name,
                "at": datetime.datetime.fromtimestamp(newest).strftime("%Y-%m-%d %H:%M"),
            }
        else:
            doc_age[k] = {"exists": True, "hours": None, "newest": ""}

    # 最近一轮是否"机器本身是好的"
    last = rounds[0] if rounds else {}
    machine_ok = (last.get("exitCode") == 0) and (last.get("status") == "complete")

    alerts = []

    # 证据 0（最高优先级）：机器本身是否异常 —— 必须先排除，否则不能下"断供"结论
    # 2026-09-27 晚实测：一轮 baidu_login_required 导致 exitCode=2/status=failed，
    # 此时 fullScanCount 为 null（根本没走到扫描），streak 被算成 0，
    # 于是哨兵只报"目录陈旧"、仍按"上游断供"措辞输出 —— 会误导成"去查录制侧"。
    if not machine_ok and last:
        alerts.append((
            "CRIT",
            f"★链路故障★：最近一轮 {last.get('file')} exitCode={last.get('exitCode')} "
            f"status={last.get('status')}（finishedAt={last.get('finishedAt')}）。"
            f"机器侧异常时不可下「上游断供」结论 —— 请先修链路（常见：百度登录态失效 errno=-6，"
            f"需扫码重登；见 state/baidu-login-qr.png）。",
        ))

    # 证据 A：连续空转
    if streak >= EMPTY_CRIT:
        alerts.append(("CRIT", f"连续 {streak} 轮空转（三表 fullScanCount 全 0），约 {streak*4}h 无新文件进入扫描"))
    elif streak >= EMPTY_WARN:
        alerts.append(("WARN", f"连续 {streak} 轮空转（三表 fullScanCount 全 0），约 {streak*4}h 无新文件"))

    # 证据 B：文稿目录陈旧
    max_h = None
    for k, v in doc_age.items():
        if v.get("exists") and v.get("hours") is not None:
            h = v["hours"]
            max_h = h if max_h is None else max(max_h, h)
            if h > MTIME_CRIT_H:
                alerts.append(("CRIT", f"{k} 文稿目录 {v['at']} 后无更新，距今 {h:.0f}h"))
            elif h > MTIME_WARN_H:
                alerts.append(("WARN", f"{k} 文稿目录 {v['at']} 后无更新，距今 {h:.0f}h"))
        elif not v.get("exists"):
            alerts.append(("WARN", f"{k} 文稿目录不存在：{DOC_DIRS[k]}"))

    # 综合判定：目录陈旧即算"零新文件"（不再要求 streak 达标 —— 机器异常时
    # 根本走不到扫描，streak 会假性归零，不能因此漏掉结论）
    supply_dry = (streak >= EMPTY_WARN) or (max_h is not None and max_h > MTIME_WARN_H)
    if supply_dry and machine_ok:
        alerts.append((
            "CRIT",
            "★上游断供（非链路故障）★：扫描 API 正常、批次 exitCode=0/status=complete，"
            "但长时间零新文件 ⇒ 是录制/上传侧没有新录屏，不是扫描坏了。请确认录制侧。",
        ))
    elif supply_dry and not machine_ok:
        alerts.append(("CRIT", "零新文件 + 最近一轮机器异常 ⇒ 结论为「链路故障」（见首条），"
                               "不要据此去查录制侧"))

    lvl = 0
    for s, _ in alerts:
        lvl = max(lvl, 2 if s == "CRIT" else 1)

    out = {
        "checked_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "level": ["OK", "WARN", "CRIT"][lvl],
        "consecutive_empty_rounds": streak,
        "rounds_checked": len(rounds),
        "machine_ok": machine_ok,
        "last_round": last,
        "doc_dir_age": doc_age,
        "alerts": [{"level": s, "msg": m} for s, m in alerts],
        # 保留最近 8 轮明细，便于人工回溯
        "recent": rounds[:8],
    }

    # 落盘（供巡检 Read）
    dest = os.path.join(BASE, "state", "supply-guard-latest.json")
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    except Exception as e:
        out["_dump_error"] = str(e)

    # 人类可读输出
    print("=" * 68)
    print(f"上游断供哨兵  {out['checked_at']}   判定={out['level']}")
    print("=" * 68)
    print(f"连续空转轮次: {streak}  (检查最近 {len(rounds)} 轮)")
    print(f"最近一轮: {last.get('finishedAt')}  exitCode={last.get('exitCode')} "
          f"status={last.get('status')}  空转={last.get('empty')}")
    print("文稿目录新鲜度:")
    for k, v in doc_age.items():
        if v.get("exists") and v.get("hours") is not None:
            print(f"   {k:<8} {v['at']}  距今 {v['hours']:.1f}h  最新={v['newest'][:40]}")
        else:
            print(f"   {k:<8} 无数据/不存在")
    print("-" * 68)
    if alerts:
        for s, m in alerts:
            print(f"[{s}] {m}")
    else:
        print("[OK] 上游供给正常，无告警")
    print("=" * 68)
    alert_supply(lvl, alerts, out, machine_ok)
    return lvl


if __name__ == "__main__":
    sys.exit(main())
