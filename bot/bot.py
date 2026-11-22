"""Interactive Telegram bot sidecar for AI Usage Manager."""
from __future__ import annotations

from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path
import time
from typing import Any
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

from board_render import (
    PROVIDER_LABELS,
    compute_best_headroom,
    format_countdown,
    render_board_png,
    unwrap_latest,
)

LONDON = ZoneInfo("Europe/London")
TG_API = "https://api.telegram.org"

COMMANDS = [
    {"command": "status", "description": "Visual PNG quota board"},
    {"command": "best", "description": "Best available headroom now"},
    {"command": "resets", "description": "Upcoming quota resets & blocks"},
    {"command": "refresh", "description": "Trigger fresh quota collection"},
    {"command": "mute5h", "description": "Mute 5h exhaustion alerts (24h/off)"},
    {"command": "quiet", "description": "Mute rollover alerts (hours/off)"},
    {"command": "help", "description": "Show bot command guide"},
]


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


class BotApp:
    def __init__(self, data_dir: Path, dashboard_url: str, token: str, owner_chat_id: str) -> None:
        self.data_dir = data_dir
        self.dashboard_url = dashboard_url
        self.token = token
        self.owner_chat_id = str(owner_chat_id).strip()

    @property
    def state_path(self) -> Path:
        return self.data_dir / "bot-state.json"

    @property
    def latest_path(self) -> Path:
        return self.data_dir / "latest.json"

    @property
    def trigger_path(self) -> Path:
        return self.data_dir / "collect.trigger"

    def load_state(self) -> dict[str, Any]:
        return _read_json(self.state_path)

    def save_state(self, state: dict[str, Any]) -> None:
        _atomic_write_json(self.state_path, state)

    def load_latest(self) -> dict[str, Any]:
        return _read_json(self.latest_path)

    def is_authorized(self, chat_id: Any, user_id: Any = None) -> bool:
        if not self.owner_chat_id:
            return False
        return str(chat_id) == self.owner_chat_id or (
            user_id is not None and str(user_id) == self.owner_chat_id
        )

    def board_keyboard(self) -> dict[str, Any]:
        row1 = [
            {"text": "🔄 Refresh", "callback_data": "aiud:refresh"},
            {"text": "💡 Best", "callback_data": "aiud:best"},
            {"text": "⏰ Resets", "callback_data": "aiud:resets"},
        ]
        row2 = [{"text": "🔇 Mute 5h 24h", "callback_data": "aiud:mute5h:24h"}]
        if self.dashboard_url.startswith(("http://", "https://")):
            row2.append({"text": "🔗 Dashboard", "url": self.dashboard_url})
        return {"inline_keyboard": [row1, row2]}

    def format_best_text(self) -> str:
        providers, exported = unwrap_latest(self.load_latest())
        headroom = compute_best_headroom(providers)
        if not headroom:
            return "<b>💡 Best headroom now</b>\nNo healthy provider windows found right now."
        lines = ["<b>💡 Best headroom now</b>"]
        now_ms = time.time() * 1000
        for item in headroom[:5]:
            reset = format_countdown(item.get("resetAt"), now_ms)
            tail = f" · resets in {html.escape(reset)}" if reset else ""
            lines.append(
                f"• <b>{html.escape(item['label'])}</b> · {html.escape(item['window'])}: <b>{item['pct']}%</b>{tail}"
            )
        if exported:
            ts = datetime.fromtimestamp(exported, tz=timezone.utc).astimezone(LONDON).strftime("%H:%M %Z")
            lines.append(f"\nSnapshot {ts}")
        return "\n".join(lines)

    def format_resets_text(self) -> str:
        providers, _ = unwrap_latest(self.load_latest())
        now_ms = time.time() * 1000
        rows: list[tuple[float, str]] = []
        for pid, r in providers.items():
            if not isinstance(r, dict):
                continue
            label = PROVIDER_LABELS.get(pid, r.get("label") or pid)
            for e in r.get("entries") or []:
                reset_at = e.get("resetAt")
                if e.get("renderType") != "percent" or not reset_at:
                    continue
                if pid == "google-antigravity" and e.get("window") in {
                    "agy-g3image",
                    "agy-g4neon",
                    "agy-g4hydrogen",
                }:
                    continue
                try:
                    norm = reset_at if reset_at.endswith("Z") or "+" in reset_at[-6:] else reset_at + "Z"
                    ts = datetime.fromisoformat(norm.replace("Z", "+00:00")).timestamp() * 1000
                except ValueError:
                    continue
                name = "Gemini 5h" if pid == "google-antigravity" and e.get("window") == "agy-g3flash" else (e.get("name") or e.get("window"))
                pct = int(round(e.get("percentRemaining") or 0))
                tag = " 🚫 limited" if e.get("limited") else ""
                rows.append((ts, f"• <b>{html.escape(label)}</b> · {html.escape(str(name))} ({pct}%{tag}): {html.escape(format_countdown(reset_at, now_ms))}"))
        rows.sort(key=lambda x: x[0])
        if not rows:
            return "<b>⏰ Upcoming resets</b>\nNo scheduled reset timestamps available."
        return "<b>⏰ Upcoming resets</b>\n" + "\n".join(line for _, line in rows[:12])

    def tg_post(self, method: str, payload: dict[str, Any], timeout: int = 15) -> dict[str, Any]:
        req = urllib.request.Request(
            f"{TG_API}/bot{self.token}/{method}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def tg_send_photo(self, chat_id: int | str, png_bytes: bytes, caption: str, reply_markup: dict[str, Any]) -> dict[str, Any]:
        boundary = f"----AIUD{os.getpid()}{int(time.time() * 1000)}"
        parts: list[bytes] = []

        def add_field(name: str, val: str) -> None:
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n".encode("utf-8")
            )

        add_field("chat_id", str(chat_id))
        add_field("caption", caption)
        add_field("parse_mode", "HTML")
        add_field("reply_markup", json.dumps(reply_markup))
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"board.png\"\r\nContent-Type: image/png\r\n\r\n".encode("utf-8")
            + png_bytes
            + b"\r\n"
        )
        parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        body = b"".join(parts)
        req = urllib.request.Request(
            f"{TG_API}/bot{self.token}/sendPhoto",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _send_text(self, chat_id: int | str, text: str, reply_markup: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        self.tg_post("sendMessage", payload)

    def send_board(self, chat_id: int | str) -> None:
        raw = self.load_latest()
        bot_state = self.load_state()
        png = render_board_png(raw, bot_state=bot_state, now_ms=time.time() * 1000)
        providers, _ = unwrap_latest(raw)
        headroom = compute_best_headroom(providers)
        top_line = (
            "💡 Top: " + ", ".join(f"<b>{html.escape(h['label'])}</b> {h['pct']}%" for h in headroom[:2])
            if headroom
            else "No active headroom"
        )
        self.tg_send_photo(chat_id, png, f"<b>📊 AI Usage Allowance Board</b>\n{top_line}", self.board_keyboard())

    def handle_command(self, msg: dict[str, Any]) -> None:
        chat_id = msg.get("chat", {}).get("id")
        user_id = msg.get("from", {}).get("id")
        if not self.is_authorized(chat_id, user_id):
            return
        text = str(msg.get("text") or "").strip()
        parts = text.split()
        cmd = parts[0].split("@")[0].lower() if parts else ""
        arg = parts[1].lower() if len(parts) > 1 else ""

        if cmd in {"/start", "/status", "/board"}:
            self.send_board(chat_id)
        elif cmd == "/best":
            self._send_text(chat_id, self.format_best_text(), {"inline_keyboard": [[{"text": "📊 Board", "callback_data": "aiud:board"}, {"text": "🔄 Refresh", "callback_data": "aiud:refresh"}]]})
        elif cmd == "/resets":
            self._send_text(chat_id, self.format_resets_text(), {"inline_keyboard": [[{"text": "📊 Board", "callback_data": "aiud:board"}]]})
        elif cmd == "/refresh":
            self.trigger_path.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
            self._send_text(chat_id, "🔄 <b>Fresh quota collection triggered.</b>\nWait ~30s, then tap Board.", {"inline_keyboard": [[{"text": "📊 Board", "callback_data": "aiud:board"}]]})
        elif cmd == "/mute5h":
            state = self.load_state()
            if arg in {"off", "0", "unmute"}:
                state.pop("mute5hUntil", None)
                self.save_state(state)
                self._send_text(chat_id, "🔊 <b>5h exhaustion alerts re-enabled.</b>")
            else:
                hours = int(arg) if arg.isdigit() and 1 <= int(arg) <= 168 else 24
                until_ms = int((time.time() + hours * 3600) * 1000)
                state["mute5hUntil"] = until_ms
                self.save_state(state)
                self._send_text(chat_id, f"🔇 <b>5h alerts muted for {hours}h.</b>", {"inline_keyboard": [[{"text": "🔊 Unmute 5h", "callback_data": "aiud:unmute5h"}]]})
        elif cmd == "/quiet":
            state = self.load_state()
            if arg in {"off", "0"}:
                state.pop("quietUntil", None)
                self.save_state(state)
                self._send_text(chat_id, "🔔 <b>Rollover quiet override cleared.</b>")
            else:
                hours = int(arg) if arg.isdigit() and 1 <= int(arg) <= 168 else 8
                state["quietUntil"] = int((time.time() + hours * 3600) * 1000)
                self.save_state(state)
                self._send_text(chat_id, f"🌙 <b>Rollover warnings paused for {hours}h.</b>")
        elif cmd == "/help":
            self._send_text(
                chat_id,
                "<b>🤖 AI Usage Manager Commands</b>\n"
                "/status — Visual quota board (PNG)\n"
                "/best — Ranked available headroom now\n"
                "/resets — Upcoming window resets &amp; active blocks\n"
                "/refresh — Trigger immediate quota collection\n"
                "/mute5h [hours|off] — Mute 5h 0% alerts (default 24h)\n"
                "/quiet [hours|off] — Pause rollover warnings (default 8h)",
            )

    def handle_callback(self, cb: dict[str, Any]) -> None:
        cb_id = cb.get("id", "")
        msg = cb.get("message") or {}
        chat_id = msg.get("chat", {}).get("id")
        user_id = cb.get("from", {}).get("id")
        if not self.is_authorized(chat_id, user_id):
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Not authorized."})
            return
        data = str(cb.get("data") or "")
        if not data.startswith("aiud:"):
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id})
            return

        if data == "aiud:board":
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Rendering quota board…"})
            self.send_board(chat_id)
        elif data == "aiud:best":
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id})
            self._send_text(chat_id, self.format_best_text())
        elif data == "aiud:resets":
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id})
            self._send_text(chat_id, self.format_resets_text())
        elif data == "aiud:refresh":
            self.trigger_path.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Refresh triggered (~30s)."})
        elif data == "aiud:mute5h:24h":
            state = self.load_state()
            state["mute5hUntil"] = int((time.time() + 24 * 3600) * 1000)
            self.save_state(state)
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": "5h alerts muted for 24h."})
            self._send_text(chat_id, "🔇 <b>5h alerts muted for 24h.</b>", {"inline_keyboard": [[{"text": "🔊 Unmute 5h", "callback_data": "aiud:unmute5h"}]]})
        elif data == "aiud:unmute5h":
            state = self.load_state()
            state.pop("mute5hUntil", None)
            self.save_state(state)
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": "5h alerts enabled."})
            self._send_text(chat_id, "🔊 <b>5h alerts re-enabled.</b>")
        elif data.startswith("aiud:ping:"):
            parts = data.split(":", 3)
            target = f"{parts[2]}:{parts[3]}" if len(parts) == 4 else parts[2]
            state = self.load_state()
            ping_map = state.setdefault("pingOnReset", {})
            ping_map[target] = datetime.now(timezone.utc).isoformat()
            self.save_state(state)
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": f"Will ping when {parts[2]} resets!"})
        else:
            self.tg_post("answerCallbackQuery", {"callback_query_id": cb_id, "text": "Unknown action."})


def resolve_telegram_config(data_dir: Path) -> tuple[str, str]:
    settings = _read_json(data_dir / "settings.json")
    tg = settings.get("telegram") if isinstance(settings.get("telegram"), dict) else {}
    token = str(tg.get("token") or os.environ.get("AIUD_TG_BOT_TOKEN") or "").strip()
    chat_id = str(tg.get("chatId") or os.environ.get("AIUD_TG_CHAT_ID") or "").strip()
    return token, chat_id


def main() -> None:
    data_dir = Path(os.environ.get("AIUD_DATA_DIR", "/data"))
    dashboard_url = os.environ.get("AIUD_DASHBOARD_URL", "https://balances.magnusfamily.co.uk/").strip()
    token, chat_id = resolve_telegram_config(data_dir)
    if not token or not chat_id:
        raise RuntimeError("Missing Telegram bot token or chatId in settings.json / env")

    bot = BotApp(data_dir, dashboard_url, token, chat_id)
    try:
        res = bot.tg_post("setMyCommands", {"commands": COMMANDS})
        print(json.dumps({"event": "setMyCommands", "ok": res.get("ok")}), flush=True)
    except Exception as exc:
        print(json.dumps({"event": "setMyCommands_failed", "error": type(exc).__name__}), flush=True)

    state = bot.load_state()
    offset = int(state.get("updateOffset") or 0)
    heartbeat = Path("/tmp/aiud-bot.alive")
    print(json.dumps({"event": "aiud-bot_started", "offset": offset}), flush=True)

    while True:
        heartbeat.write_text(str(time.time()), encoding="utf-8")
        try:
            url = f"{TG_API}/bot{bot.token}/getUpdates?timeout=30&offset={offset}&allowed_updates=%5B%22message%22,%22callback_query%22%5D"
            with urllib.request.urlopen(url, timeout=40) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            for upd in data.get("result") or []:
                uid = int(upd["update_id"])
                offset = max(offset, uid + 1)
                if "message" in upd:
                    bot.handle_command(upd["message"])
                elif "callback_query" in upd:
                    bot.handle_callback(upd["callback_query"])
                st = bot.load_state()
                st["updateOffset"] = offset
                bot.save_state(st)
        except urllib.error.HTTPError as exc:
            print(json.dumps({"event": "poll_http_error", "code": exc.code}), flush=True)
            time.sleep(5 if exc.code != 409 else 15)
        except Exception as exc:
            print(json.dumps({"event": "poll_error", "error": type(exc).__name__}), flush=True)
            time.sleep(5)


if __name__ == "__main__":
    main()
