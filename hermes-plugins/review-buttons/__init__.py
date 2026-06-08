"""review-buttons — inline Telegram buttons for the Pocket review queue.

The construction-bi-pipeline ingest digest (pocket-ingest.js) attaches inline
buttons whose ``callback_data`` is ``rq:<verb>:<rq_id>``. Hermes's Telegram
gateway only knows a fixed set of callback prefixes and has **no plugin seam**
for new ones, so this plugin wraps ``TelegramAdapter._handle_callback_query``
at startup to intercept ``rq:`` callbacks and shell out to ``review-cli.js``.

Design / safety:
  * The wrapper is exception-guarded and ONLY acts on ``rq:`` data. Every other
    callback — and any error in our code — falls straight through to the
    original handler, so existing buttons (ea:/sc:/gt:/cl:/mp:…) are untouched.
  * Idempotent: a sentinel attribute prevents double-wrapping on plugin reload.
  * Self-healing across hermes-agent upgrades: this plugin lives in
    ``~/.hermes/plugins`` (outside the vendored tree) and re-applies the wrap on
    every gateway start.
  * Approve is a LIVE Jobber write, so it is two-tap: the first tap posts a
    separate confirm message ([✅ Confirm] / [✖ Cancel]); only the confirm runs
    the write. We never edit the shared digest's keyboard (that would clobber
    sibling items), so actions emit toasts / new messages instead.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess

logger = logging.getLogger("hermes.plugins.review-buttons")

# Matches the /review skill's hardcoded invocation.
NODE_BIN = "/root/.hermes/node/bin/node"
REVIEW_CLI = "/root/construction-bi-pipeline/review-cli.js"

_VALID_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def _valid_id(rq_id: str) -> bool:
    """rq_<12 hex> — defensively reject anything else (no shell injection vectors)."""
    return (
        isinstance(rq_id, str)
        and rq_id.startswith("rq_")
        and 4 <= len(rq_id) <= 40
        and all(c in _VALID_ID_CHARS for c in rq_id)
    )


def _run_review_cli(args: list) -> str:
    """Run review-cli.js synchronously; return combined stdout/stderr (truncated)."""
    try:
        proc = subprocess.run(
            [NODE_BIN, REVIEW_CLI, *args],
            capture_output=True, text=True, timeout=120,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        out = out.strip() or f"(no output, exit {proc.returncode})"
    except Exception as exc:  # noqa: BLE001 — surface any failure to the user
        out = f"review-cli failed: {exc}"
    return out[:3500]


async def _review_cli(args: list) -> str:
    """Async wrapper — never block the gateway event loop on the subprocess."""
    return await asyncio.to_thread(_run_review_cli, args)


def _confirm_keyboard(rq_id: str):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Confirm", callback_data=f"rq:approveok:{rq_id}"),
        InlineKeyboardButton("✖ Cancel", callback_data=f"rq:cancel:{rq_id}"),
    ]])


async def _handle_review_callback(adapter, query, data: str) -> None:
    """Handle a single ``rq:<verb>:<id>`` callback. Best-effort; logs on error."""
    parts = data.split(":", 2)
    verb = parts[1] if len(parts) > 1 else ""
    rq_id = parts[2] if len(parts) > 2 else ""

    # cancel carries an id but needs no auth/cli — just close the confirm prompt.
    if verb == "cancel":
        await query.answer(text="Cancelled")
        try:
            await query.edit_message_text(text="✖ Approval cancelled.")
        except Exception:
            pass
        return

    if not _valid_id(rq_id):
        await query.answer(text="Invalid item id.")
        return

    # Authorize the tapper using the gateway's own check (only Luis/Z may act).
    msg = getattr(query, "message", None)
    chat = getattr(msg, "chat", None)
    caller_id = str(getattr(getattr(query, "from_user", None), "id", "") or "")
    authorized = False
    try:
        authorized = adapter._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(msg, "chat_id", None),
            chat_type=(str(getattr(chat, "type", None)) if getattr(chat, "type", None) is not None else None),
            thread_id=(str(getattr(msg, "message_thread_id", None)) if getattr(msg, "message_thread_id", None) is not None else None),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        )
    except Exception:
        logger.exception("review-buttons: auth check raised; denying")
        authorized = False
    if not authorized:
        await query.answer(text="⛔ Not authorized.")
        return

    if verb == "show":
        await query.answer()
        out = await _review_cli(["show", rq_id])
        try:
            await query.message.reply_text(f"👁 {rq_id}\n\n{out}")
        except Exception:
            logger.exception("review-buttons: show reply failed")
        return

    if verb == "dismiss":
        await query.answer(text="Dismissing…")
        out = await _review_cli(["dismiss", rq_id, "--reason", "dismissed via Telegram button"])
        try:
            await query.message.reply_text(f"🗑 {rq_id}\n{out}")
        except Exception:
            logger.exception("review-buttons: dismiss reply failed")
        return

    if verb == "approve":
        # First tap: do NOT write. Post a separate confirm prompt.
        await query.answer()
        try:
            await query.message.reply_text(
                f"⚠️ Approve {rq_id}? This writes the note to Jobber.",
                reply_markup=_confirm_keyboard(rq_id),
            )
        except Exception:
            logger.exception("review-buttons: approve confirm prompt failed")
        return

    if verb == "approveok":
        # Second tap: perform the live write, then strip the confirm buttons.
        await query.answer(text="Approving…")
        out = await _review_cli(["approve", rq_id])
        try:
            await query.edit_message_text(text=f"✅ approve {rq_id}\n\n{out}")
        except Exception:
            try:
                await query.message.reply_text(f"✅ approve {rq_id}\n\n{out}")
            except Exception:
                logger.exception("review-buttons: approveok reply failed")
        return

    await query.answer(text="Unknown action.")


def _install_wrap() -> bool:
    """Monkeypatch TelegramAdapter._handle_callback_query to intercept rq:* .

    Returns True if wrapped (or already wrapped), False if the adapter is not
    importable (e.g. running outside the gateway) — in which case this plugin
    is simply a no-op.
    """
    try:
        from gateway.platforms.telegram import TelegramAdapter
    except Exception:
        logger.debug("review-buttons: TelegramAdapter not importable; skipping wrap")
        return False

    orig = TelegramAdapter._handle_callback_query
    if getattr(orig, "_rq_wrapped", False):
        return True  # idempotent — already installed this process

    async def _wrapped(self, update, context):  # noqa: ANN001
        try:
            query = getattr(update, "callback_query", None)
            data = getattr(query, "data", "") or ""
            if data.startswith("rq:"):
                return await _handle_review_callback(self, query, data)
        except Exception:
            # Never let our code break inbound handling — fall through to original.
            logger.exception("review-buttons: rq handler raised; deferring to original")
        return await orig(self, update, context)

    _wrapped._rq_wrapped = True  # type: ignore[attr-defined]
    TelegramAdapter._handle_callback_query = _wrapped
    logger.info("review-buttons: installed rq:* callback handler")
    return True


def register(ctx) -> None:  # noqa: ANN001 — Hermes plugin entrypoint
    """Plugin entrypoint — runs at gateway/CLI startup."""
    try:
        _install_wrap()
    except Exception:
        logger.exception("review-buttons: failed to install callback wrap")
