"""Tests for AI Usage Manager board renderer and Telegram bot handlers."""
from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import time

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board_render  # noqa: E402
import bot  # noqa: E402

SAMPLE_LATEST = {
    "receivedAt": 1795335012388,
    "envelope": {
        "version": 2,
        "exportedAt": 1795335012,
        "providers": {
            "anthropic": {
                "status": "ok",
                "label": "Claude",
                "entries": [
                    {"name": "5h", "window": "5h", "renderType": "percent", "percentRemaining": 98, "resetAt": "2026-11-22T11:49:59Z"},
                    {"name": "Weekly", "window": "weekly", "renderType": "percent", "percentRemaining": 0, "resetAt": "2026-11-23T02:59:59Z"},
                ],
            },
            "openai": {
                "status": "ok",
                "label": "ChatGPT",
                "entries": [
                    {"name": "Weekly", "window": "weekly", "renderType": "percent", "percentRemaining": 94, "resetAt": "2026-11-28T10:06:42Z"},
                ],
            },
            "google-antigravity": {
                "status": "ok",
                "label": "Gemini · Antigravity",
                "entries": [
                    {"name": "Gemini Flash", "window": "agy-g3flash", "renderType": "percent", "percentRemaining": 79, "resetAt": "2026-11-22T12:39:00Z"},
                    {"name": "Gemini Neon", "window": "agy-g4neon", "renderType": "percent", "percentRemaining": 79, "resetAt": "2026-11-22T12:39:00Z"},
                    {"name": "Gemini weekly", "window": "agy-gemini-weekly", "renderType": "percent", "percentRemaining": 92, "resetAt": "2026-11-28T12:03:06Z"},
                ],
            },
            "opencode-go": {
                "status": "ok",
                "label": "OpenCode Go",
                "entries": [
                    {"name": "This week", "window": "weekly", "renderType": "percent", "percentRemaining": 89, "resetAt": "2026-11-23T00:00:00Z"},
                    {"name": "This month (limited)", "window": "monthly", "renderType": "percent", "percentRemaining": 0, "resetAt": "2026-11-25T09:45:11Z", "limited": True},
                ],
            },
        },
    },
}


def test_render_board_png_produces_valid_image():
    png = board_render.render_board_png(SAMPLE_LATEST, now_ms=1795335012000)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    im = Image.open(io.BytesIO(png))
    assert im.size[0] == 920
    assert im.size[1] >= 320


def test_compute_best_headroom_excludes_monthly_limited_opencode_go():
    providers, _ = board_render.unwrap_latest(SAMPLE_LATEST)
    picks = board_render.compute_best_headroom(providers)
    ids = [p["id"] for p in picks]
    assert "openai" in ids
    assert "opencode-go" not in ids


def test_argon_catalogue_window_is_shared_5h_not_durable():
    # Since 2026-11-24 Argon sits on the shared Gemini 5h bucket
    # (window agy-g4argon-5h). Its id contains "argon", which must not earn
    # it the durable-weekly headroom boost, and it must not get a second bar
    # beside the collapsed "Gemini 5h (shared)" row.
    agy = {
        "status": "ok",
        "label": "google-antigravity",
        "entries": [
            {"name": "Gemini Neon", "window": "agy-g4neon", "renderType": "percent", "percentRemaining": 50, "resetAt": "2026-11-24T21:00:58Z"},
            {"name": "G4Argon", "window": "agy-g4argon-5h", "renderType": "percent", "percentRemaining": 40, "resetAt": "2026-11-24T21:00:58Z"},
            {"name": "Gemini weekly", "window": "agy-gemini-weekly", "renderType": "percent", "percentRemaining": 30, "resetAt": "2026-12-01T08:00:58Z"},
        ],
    }
    picks = board_render.compute_best_headroom({"google-antigravity": agy})
    assert [p["window"] for p in picks] == ["Gemini weekly"]

    names = [row["name"] for row in board_render._collapse_provider_rows("google-antigravity", agy, 1795335012000)["rows"]]
    assert names == ["Gemini 5h (shared)", "Gemini weekly"]

    # The old summary-sourced weekly Argon window stays durable: 40% weekly
    # still outranks a fuller 5h row.
    weekly_argon = {
        "status": "ok",
        "label": "google-antigravity",
        "entries": [
            {"name": "Gemini Neon", "window": "agy-g4neon", "renderType": "percent", "percentRemaining": 50, "resetAt": "2026-11-24T21:00:58Z"},
            {"name": "G4Argon", "window": "agy-g4argon", "renderType": "percent", "percentRemaining": 40, "resetAt": "2026-11-26T07:21:22Z"},
        ],
    }
    picks = board_render.compute_best_headroom({"google-antigravity": weekly_argon})
    assert [p["window"] for p in picks] == ["G4Argon"]


def test_bot_commands_and_callbacks_and_auth_guard(tmp_path: Path):
    (tmp_path / "latest.json").write_text(json.dumps(SAMPLE_LATEST), encoding="utf-8")
    sent_posts: list[tuple[str, dict]] = []
    sent_photos: list[tuple[int | str, bytes, str]] = []

    app = bot.BotApp(tmp_path, "https://balances.example/", "tok", "7967413811")
    app.tg_post = lambda m, p, timeout=15: sent_posts.append((m, p)) or {"ok": True}  # type: ignore[method-assign]
    app.tg_send_photo = lambda cid, png, cap, rm: sent_photos.append((cid, png, cap)) or {"ok": True}  # type: ignore[method-assign]

    # Unauthorized user cannot trigger refresh or change state
    app.handle_command({"chat": {"id": 999}, "from": {"id": 999}, "text": "/refresh"})
    app.handle_callback({"id": "cb0", "from": {"id": 999}, "message": {"chat": {"id": 999}}, "data": "aiud:mute5h:24h"})
    assert not (tmp_path / "collect.trigger").exists()
    assert not (tmp_path / "bot-state.json").exists()
    assert sent_posts[-1][1]["text"] == "Not authorized."

    # Authorized commands
    app.handle_command({"chat": {"id": 7967413811}, "from": {"id": 7967413811}, "text": "/status"})
    assert len(sent_photos) == 1 and sent_photos[0][1].startswith(b"\x89PNG")

    app.handle_command({"chat": {"id": 7967413811}, "from": {"id": 7967413811}, "text": "/refresh"})
    assert (tmp_path / "collect.trigger").exists()

    app.handle_callback({"id": "cb1", "from": {"id": 7967413811}, "message": {"chat": {"id": 7967413811}}, "data": "aiud:mute5h:24h"})
    state = json.loads((tmp_path / "bot-state.json").read_text(encoding="utf-8"))
    assert state["mute5hUntil"] > time.time() * 1000

    app.handle_callback({"id": "cb2", "from": {"id": 7967413811}, "message": {"chat": {"id": 7967413811}}, "data": "aiud:ping:anthropic:weekly"})
    state = json.loads((tmp_path / "bot-state.json").read_text(encoding="utf-8"))
    assert "anthropic:weekly" in state["pingOnReset"]

    app.handle_callback({"id": "cb3", "from": {"id": 7967413811}, "message": {"chat": {"id": 7967413811}}, "data": "aiud:unmute5h"})
    state = json.loads((tmp_path / "bot-state.json").read_text(encoding="utf-8"))
    assert "mute5hUntil" not in state
