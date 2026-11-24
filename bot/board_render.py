"""Dark-mode PNG quota board renderer for AI Usage Manager Telegram bot."""
from __future__ import annotations

from datetime import datetime, timezone
import io
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont

LONDON = ZoneInfo("Europe/London")

PROVIDER_ORDER = [
    "anthropic",
    "openai",
    "google-antigravity",
    "zai",
    "opencode-go",
    "alibaba-coding-plan",
    "radeon-cloud",
]

PROVIDER_LABELS = {
    "anthropic": "Claude",
    "openai": "ChatGPT",
    "google-antigravity": "Gemini · Antigravity",
    "zai": "Z.ai",
    "opencode-go": "OpenCode Go",
    "alibaba-coding-plan": "Qwen",
    "radeon-cloud": "Radeon Cloud",
}

BG = (15, 20, 28)
CARD_BG = (24, 31, 43)
BORDER = (46, 58, 78)
TEXT_MAIN = (237, 242, 247)
TEXT_MUTED = (148, 163, 184)
ACCENT_BLUE = (96, 165, 250)
GREEN = (34, 197, 94)
AMBER = (245, 158, 11)
RED = (239, 68, 68)
DARK_RED = (127, 29, 29)
BAR_BG = (38, 48, 66)


def _load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = (
        [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
        ]
        if bold
        else [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    )
    for path in candidates:
        try:
            if Path(path).exists():
                return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def unwrap_latest(raw: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Return (providers_dict, exported_epoch_seconds)."""
    env = raw.get("envelope") if isinstance(raw.get("envelope"), dict) else raw
    providers = env.get("providers") if isinstance(env.get("providers"), dict) else {}
    exported = int(env.get("exportedAt") or (int(raw.get("receivedAt", 0)) // 1000) or 0)
    return providers, exported


def format_countdown(reset_iso: str | None, now_ms: float) -> str:
    if not reset_iso:
        return ""
    try:
        norm = reset_iso if reset_iso.endswith("Z") or "+" in reset_iso[-6:] else reset_iso + "Z"
        dt = datetime.fromisoformat(norm.replace("Z", "+00:00"))
    except ValueError:
        return ""
    diff_s = max(0, int((dt.timestamp() * 1000 - now_ms) // 1000))
    days, rem = divmod(diff_s, 86400)
    hours, rem = divmod(rem, 3600)
    mins = rem // 60
    if days >= 1:
        countdown = f"{days}d {hours}h"
    elif hours >= 1:
        countdown = f"{hours}h {mins}m"
    else:
        countdown = f"{mins}m"
    local = dt.astimezone(LONDON).strftime("%a %H:%M")
    return f"{countdown} ({local})"


def compute_best_headroom(providers: dict[str, Any]) -> list[dict[str, Any]]:
    picks: list[dict[str, Any]] = []
    for pid, r in providers.items():
        if not isinstance(r, dict) or r.get("status") != "ok":
            continue
        entries = r.get("entries") or []
        if any(e.get("limited") and (e.get("percentRemaining") or 0) <= 0 for e in entries):
            continue
        best = None
        for e in entries:
            if e.get("renderType") != "percent":
                continue
            pct = e.get("percentRemaining")
            if not isinstance(pct, (int, float)) or pct <= 0 or e.get("limited"):
                continue
            win = str(e.get("window") or "")
            win_l = win.lower()
            # Argon's catalogue window (agy-g4argon-5h) shares the Gemini 5h
            # bucket; only the summary's weekly agy-g4argon is durable.
            is_durable = (
                "week" in win_l
                or "month" in win_l
                or "week" in str(e.get("name") or "").lower()
                or "month" in str(e.get("name") or "").lower()
                or win_l == "agy-g4argon"
            )
            score = (1 if is_durable and pct >= 30 else 0, float(pct))
            if best is None or score > best[0]:
                best = (score, e)
        if best:
            e = best[1]
            picks.append(
                {
                    "id": pid,
                    "label": PROVIDER_LABELS.get(pid, r.get("label") or pid),
                    "window": e.get("name") or e.get("window") or "",
                    "pct": int(round(e["percentRemaining"])),
                    "resetAt": e.get("resetAt"),
                }
            )
    picks.sort(key=lambda item: item["pct"], reverse=True)
    return picks


def _collapse_provider_rows(pid: str, r: dict[str, Any], now_ms: float) -> dict[str, Any]:
    label = PROVIDER_LABELS.get(pid, r.get("label") or pid)
    status = r.get("status", "unknown")
    entries = r.get("entries") or []
    rows: list[dict[str, Any]] = []
    seen_5h_agy = False

    for e in entries:
        rt = e.get("renderType")
        if rt == "percent" and isinstance(e.get("percentRemaining"), (int, float)):
            win = str(e.get("window") or "")
            name = str(e.get("name") or win)
            # Every Antigravity row on the shared Gemini 5h bucket collapses
            # into one bar. Argon joined that bucket on 2026-11-24 (window
            # agy-g4argon-5h); only the old weekly agy-g4argon was separate.
            if pid == "google-antigravity" and win in {
                "agy-g3flash",
                "agy-g3pro",
                "agy-g3image",
                "agy-g4neon",
                "agy-g4hydrogen",
                "agy-g4argon-5h",
            }:
                if seen_5h_agy:
                    continue
                seen_5h_agy = True
                name = "Gemini 5h (shared)"
            rows.append(
                {
                    "kind": "bar",
                    "name": name,
                    "pct": float(e["percentRemaining"]),
                    "limited": bool(e.get("limited")),
                    "reset": format_countdown(e.get("resetAt"), now_ms),
                }
            )
    if not rows and pid == "radeon-cloud" and entries:
        avail = sum(1 for e in entries if e.get("state") in {"available", "low"})
        busy = sum(1 for e in entries if e.get("state") == "busy")
        full = sum(1 for e in entries if e.get("state") == "full")
        rows.append(
            {
                "kind": "note",
                "text": f"Models: {avail} open · {busy} busy · {full} full",
            }
        )
    if status == "error":
        rows.append({"kind": "error", "text": str(r.get("error") or "Collection failed")[:68]})
    return {"id": pid, "label": label, "status": status, "rows": rows}


def _bar_color(pct: float, limited: bool) -> tuple[int, int, int]:
    if limited or pct <= 0:
        return RED if limited else DARK_RED
    if pct <= 15:
        return RED
    if pct < 50:
        return AMBER
    return GREEN


def render_board_png(
    latest_raw: dict[str, Any],
    bot_state: dict[str, Any] | None = None,
    now_ms: float | None = None,
) -> bytes:
    """Render AI usage board PNG bytes from latest.json structure."""
    now_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    providers, exported = unwrap_latest(latest_raw)
    bot_state = bot_state or {}

    ordered_ids = [pid for pid in PROVIDER_ORDER if pid in providers] + [
        pid for pid in providers if pid not in PROVIDER_ORDER
    ]
    cards = [_collapse_provider_rows(pid, providers[pid], now_ms) for pid in ordered_ids]
    headroom = compute_best_headroom(providers)

    width = 920
    pad_x = 28
    card_pad = 16
    row_h = 34
    card_header_h = 36
    card_gap = 12
    header_h = 104
    footer_h = 42

    total_h = header_h + sum(
        card_header_h + max(1, len(c["rows"])) * row_h + card_pad + card_gap for c in cards
    ) + footer_h
    total_h = max(320, total_h)

    img = Image.new("RGB", (width, total_h), BG)
    draw = ImageDraw.Draw(img)

    f_title = _load_font(24, bold=True)
    f_sub = _load_font(14)
    f_card = _load_font(17, bold=True)
    f_row = _load_font(14)
    f_row_b = _load_font(14, bold=True)
    f_small = _load_font(12)

    # Header
    draw.text((pad_x, 20), "AI Usage Allowance Board", font=f_title, fill=TEXT_MAIN)
    if exported:
        ts = datetime.fromtimestamp(exported, tz=timezone.utc).astimezone(LONDON).strftime("%a %d %b %H:%M %Z")
        sub_txt = f"Updated {ts}"
    else:
        sub_txt = "No snapshot timestamp"
    flags = []
    if float(bot_state.get("mute5hUntil") or 0) > now_ms:
        flags.append("5h muted")
    if float(bot_state.get("quietUntil") or 0) > now_ms:
        flags.append("Quiet active")
    if flags:
        sub_txt += " · " + " · ".join(flags)
    draw.text((pad_x, 52), sub_txt, font=f_sub, fill=TEXT_MUTED)

    if headroom:
        top = ", ".join(f"{h['label']} {h['pct']}%" for h in headroom[:3])
        draw.text((pad_x, 75), f"Best headroom: {top}", font=f_row_b, fill=ACCENT_BLUE)
    else:
        draw.text((pad_x, 75), "No active headroom detected", font=f_row_b, fill=AMBER)

    y = header_h
    card_w = width - 2 * pad_x
    for c in cards:
        n_rows = max(1, len(c["rows"]))
        ch = card_header_h + n_rows * row_h + card_pad
        draw.rounded_rectangle([pad_x, y, pad_x + card_w, y + ch], radius=12, fill=CARD_BG, outline=BORDER, width=1)
        draw.text((pad_x + 16, y + 10), c["label"], font=f_card, fill=TEXT_MAIN)
        status_label = "OK" if c["status"] == "ok" else str(c["status"]).upper()
        status_color = GREEN if c["status"] == "ok" else RED
        draw.text((width - pad_x - 78, y + 12), status_label, font=f_small, fill=status_color)

        ry = y + card_header_h + 2
        if not c["rows"]:
            draw.text((pad_x + 16, ry + 4), "No numeric windows", font=f_row, fill=TEXT_MUTED)
        for row in c["rows"]:
            if row["kind"] == "bar":
                pct = max(0.0, min(100.0, row["pct"]))
                pct_str = f"{int(round(pct))}%"
                draw.text((pad_x + 16, ry + 4), row["name"][:28], font=f_row, fill=TEXT_MAIN)

                bx0, by0, bx1, by1 = pad_x + 250, ry + 8, pad_x + 560, ry + 22
                draw.rounded_rectangle([bx0, by0, bx1, by1], radius=6, fill=BAR_BG)
                fill_w = int((bx1 - bx0) * (pct / 100.0))
                if fill_w > 0:
                    draw.rounded_rectangle(
                        [bx0, by0, max(bx0 + 6, bx0 + fill_w), by1],
                        radius=6,
                        fill=_bar_color(pct, row["limited"]),
                    )
                draw.text((bx1 + 14, ry + 4), pct_str, font=f_row_b, fill=TEXT_MAIN)
                reset_txt = ("Cap blocked · " if row["limited"] else "") + (row["reset"] or "")
                draw.text((bx1 + 66, ry + 5), reset_txt[:34], font=f_small, fill=TEXT_MUTED)
            elif row["kind"] == "note":
                draw.text((pad_x + 16, ry + 4), row["text"], font=f_row, fill=TEXT_MUTED)
            elif row["kind"] == "error":
                draw.text((pad_x + 16, ry + 4), row["text"], font=f_row, fill=RED)
            ry += row_h
        y += ch + card_gap

    draw.text((pad_x, total_h - 28), "balances.magnusfamily.co.uk · Use buttons below for details", font=f_small, fill=TEXT_MUTED)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
