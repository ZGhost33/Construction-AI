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
import json
import logging
import re
import subprocess

logger = logging.getLogger("hermes.plugins.review-buttons")

# Matches the /review skill's hardcoded invocation.
NODE_BIN = "/root/.hermes/node/bin/node"
REPO_DIR = "/root/construction-bi-pipeline"
REVIEW_CLI = REPO_DIR + "/review-cli.js"
COMMIT_CLI = REPO_DIR + "/commit-cli.js"
STATUS_CLI = REPO_DIR + "/status-cli.js"
GMAIL_CLI = REPO_DIR + "/gmail-cli.js"
CLIENT_CLI = REPO_DIR + "/client-cli.js"
INFERENCE_CLI = REPO_DIR + "/inference-cli.js"
MENU_MANIFEST = REPO_DIR + "/telegram-menu.json"

import os as _os
import re as _re

# Resolve a manifest 'cli' filename to its absolute path under the repo. No
# hardcoded allow-list: any *-cli.js the manifest names is dispatchable, so a
# new menu command can't be "registered but unresolved" (the /observe bug).
# The filename is from the committed manifest, not user input; still restricted
# to a safe basename and required to exist on disk.
def _resolve_cli(name):
    if not name or not _re.fullmatch(r"[a-z0-9][a-z0-9._-]*\.js", str(name)):
        return None
    p = _os.path.join(REPO_DIR, name)
    return p if _os.path.isfile(p) else None

_VALID_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
_VALID_FILTER = {"a", "u", "l"}  # card-cycler filter codes (all / unknown / low-conf)

# Free-text reply capture (review notes, email-draft edits). When the operator
# taps 📝 Add note / ✏️ Edit we send a ForceReply prompt and remember it here,
# keyed by the prompt's message_id with a "kind" discriminator. The wrapped
# text handler consumes the operator's reply, applies it via the right CLI,
# and refreshes the original card in place. Process-local (single gateway proc).
_PENDING_NOTES: dict = {}


def _gc_pending() -> None:
    """Bound the pending-notes map so an abandoned prompt never leaks memory."""
    if len(_PENDING_NOTES) > 100:
        for k in list(_PENDING_NOTES.keys())[: len(_PENDING_NOTES) - 100]:
            _PENDING_NOTES.pop(k, None)


def _valid_id(rq_id: str) -> bool:
    """rq_<12 hex> — defensively reject anything else (no shell injection vectors)."""
    return (
        isinstance(rq_id, str)
        and rq_id.startswith("rq_")
        and 4 <= len(rq_id) <= 40
        and all(c in _VALID_ID_CHARS for c in rq_id)
    )


def _run_cli(cli: str, args: list) -> str:
    """Run a pipeline Node CLI synchronously; return stdout/stderr (truncated)."""
    try:
        proc = subprocess.run(
            [NODE_BIN, cli, *args],
            capture_output=True, text=True, timeout=120,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        out = out.strip() or f"(no output, exit {proc.returncode})"
    except Exception as exc:  # noqa: BLE001 — surface any failure to the user
        out = f"cli failed: {exc}"
    return out[:3500]


def _run_review_cli(args: list) -> str:
    return _run_cli(REVIEW_CLI, args)


async def _review_cli(args: list) -> str:
    """Async wrapper — never block the gateway event loop on the subprocess."""
    return await asyncio.to_thread(_run_review_cli, args)


# ── card cycler (JSON render payloads) ────────────────────────────────────────
async def _review_cli_json(args: list):
    return await asyncio.to_thread(_run_cli_json, REVIEW_CLI, args)


def _run_cli_json(cli: str, args: list):
    """Run a payload-emitting CLI command and parse its JSON render payload."""
    out = _run_cli(cli, args)
    s = (out or "").strip()
    try:
        return json.loads(s)
    except Exception:
        for line in reversed(s.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except Exception:
                    continue
    return None


async def _commit_cli_json(args: list):
    return await asyncio.to_thread(_run_cli_json, COMMIT_CLI, args)


async def _status_cli_json(args: list):
    return await asyncio.to_thread(_run_cli_json, STATUS_CLI, args)


async def _gmail_cli_json(args: list):
    return await asyncio.to_thread(_run_cli_json, GMAIL_CLI, args)


async def _client_cli_json(args: list):
    return await asyncio.to_thread(_run_cli_json, CLIENT_CLI, args)


async def _inference_cli_json(args: list):
    return await asyncio.to_thread(_run_cli_json, INFERENCE_CLI, args)


# ── bot-menu manifest (single source of truth, shared with telegram-menu.js) ──
_MENU_FALLBACK = [
    {"cmd": "review", "desc": "📋 Review queue", "handler": {"type": "render", "cli": "review-cli.js", "args": ["card", "--at", "first", "--f", "a"]}},
    {"cmd": "tasks", "desc": "✅ Tasks", "handler": {"type": "render", "cli": "commit-cli.js", "args": ["home"]}},
    {"cmd": "status", "desc": "🔍 Status", "handler": {"type": "render", "cli": "status-cli.js", "args": ["status"]}},
    {"cmd": "today", "desc": "📅 Today", "handler": {"type": "render", "cli": "status-cli.js", "args": ["today"]}},
]


def _load_menu():
    """Read the menu manifest → list of command dicts. Falls back to a built-in
    list if the file is missing/unreadable so the bot never loses its menu."""
    try:
        with open(MENU_MANIFEST, "r", encoding="utf-8") as fh:
            cmds = json.load(fh).get("commands", [])
        return cmds if cmds else _MENU_FALLBACK
    except Exception:
        logger.debug("review-buttons: menu manifest unreadable; using fallback")
        return _MENU_FALLBACK


def _kbd(reply_markup):
    """Convert a {'inline_keyboard': [[{text, callback_data}]]} dict from the CLI
    into a telegram InlineKeyboardMarkup (or None)."""
    if not reply_markup:
        return None
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    rows = []
    for r in reply_markup.get("inline_keyboard", []):
        rows.append([
            InlineKeyboardButton(b.get("text", "?"), callback_data=b.get("callback_data", "rq:noop"))
            for b in r
        ])
    return InlineKeyboardMarkup(rows) if rows else None


async def _apply_edit(query, payload) -> None:
    """Edit the tapped message to match a CLI render payload (no toast/answer).

    Degrades gracefully on a Markdown parse error or a no-op edit (Telegram
    'message is not modified')."""
    text = payload.get("text", "")
    markup = _kbd(payload.get("reply_markup"))
    parse_mode = payload.get("parse_mode")
    try:
        await query.edit_message_text(text=text, reply_markup=markup, parse_mode=parse_mode)
    except Exception:
        # Markdown error → retry as plain text; identical-content edit → ignore.
        try:
            await query.edit_message_text(text=text, reply_markup=markup)
        except Exception:
            logger.debug("review-buttons: in-place edit skipped (no-op or transient)")


async def _render_in_place(query, payload) -> None:
    """Answer the tapped callback (optional toast/alert) then edit it in place."""
    if not payload:
        await query.answer(text="Couldn't render — try again.")
        return
    ans = payload.get("answer")
    await query.answer(text=ans, show_alert=bool(payload.get("alert"))) if ans else await query.answer()
    await _apply_edit(query, payload)


def _authorize(adapter, query):
    """Authorize a callback tap via the gateway's own check.

    Returns (authorized: bool, op: str) where op is the tapping operator's
    first name (used for --by / --op attribution in the CLIs).
    """
    msg = getattr(query, "message", None)
    chat = getattr(msg, "chat", None)
    from_user = getattr(query, "from_user", None)
    caller_id = str(getattr(from_user, "id", "") or "")
    op = (getattr(from_user, "first_name", None) or caller_id or "unknown")
    try:
        authorized = adapter._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(msg, "chat_id", None),
            chat_type=(str(getattr(chat, "type", None)) if getattr(chat, "type", None) is not None else None),
            thread_id=(str(getattr(msg, "message_thread_id", None)) if getattr(msg, "message_thread_id", None) is not None else None),
            user_name=getattr(from_user, "first_name", None),
        )
    except Exception:
        logger.exception("review-buttons: auth check raised; denying")
        authorized = False
    return authorized, op


def _confirm_keyboard(rq_id: str):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Confirm", callback_data=f"rq:approveok:{rq_id}"),
        InlineKeyboardButton("✖ Cancel", callback_data=f"rq:cancel:{rq_id}"),
    ]])


async def _handle_review_callback(adapter, query, data: str) -> None:
    """Route an ``rq:`` callback. Best-effort; logs on error.

    Grammar (the active filter rides as a 1-char code so state is stateless):
      rq:noop                         — position label / disabled nav
      rq:<verb>:<id>                  — legacy digest buttons (show/approve/dismiss)
      rq:<verb>:<F>:<id>              — card buttons (skip/next/prev/card/upd/flt/uc/us/un)
      rq:setf:<newF>:<id>             — apply a new filter
      rq:<verb>:<F>:<arg>:<id>        — pickers (xc/xs select, pc/ps paginate)
    """
    parts = data.split(":")
    verb = parts[1] if len(parts) > 1 else ""

    # noop / cancel need no auth or CLI.
    if verb == "noop":
        await query.answer()
        return
    if verb == "cancel":
        await query.answer(text="Cancelled")
        try:
            await query.edit_message_text(text="✖ Approval cancelled.")
        except Exception:
            pass
        return

    rq_id = parts[-1] if parts else ""
    if not _valid_id(rq_id):
        await query.answer(text="Invalid item id.")
        return

    # Filter code: position 2 when present and a known code (also the NEW filter
    # for setf); otherwise default to 'all'. Picker arg (idx/page) is position 3.
    code = parts[2] if len(parts) >= 4 and parts[2] in _VALID_FILTER else "a"
    arg = parts[3] if len(parts) >= 5 else None
    from_card = len(parts) >= 4  # 4+ segments ⇒ tapped on a card, edit in place

    # Authorize via the gateway's own check (governs who may act in this chat).
    authorized, op = _authorize(adapter, query)
    if not authorized:
        await query.answer(text="⛔ Not authorized.")
        return

    # ── card navigation / rendering (edit the tapped card in place) ───────────
    if verb in ("skip", "next"):
        await _render_in_place(query, await _review_cli_json(["card", "--at", rq_id, "--move", "next", "--f", code]))
        return
    if verb == "prev":
        await _render_in_place(query, await _review_cli_json(["card", "--at", rq_id, "--move", "prev", "--f", code]))
        return
    if verb == "card":  # re-render here (Back button, and the digest's "open cards" entry)
        await _render_in_place(query, await _review_cli_json(["card", "--at", rq_id, "--move", "here", "--f", code]))
        return
    if verb == "setf":  # code already holds the new filter
        await _render_in_place(query, await _review_cli_json(["card", "--at", rq_id, "--move", "here", "--f", code]))
        return
    if verb == "flt":
        await _render_in_place(query, await _review_cli_json(["filter-menu", "--id", rq_id, "--f", code]))
        return
    if verb == "full":  # full detail view (summary + transcript + complete note)
        await _render_in_place(query, await _review_cli_json(["detail", "--id", rq_id, "--f", code]))
        return
    if verb == "upd":
        await _render_in_place(query, await _review_cli_json(["update-menu", "--id", rq_id, "--f", code]))
        return

    # ── Update sub-flow: pickers + corrections ────────────────────────────────
    if verb in ("uc", "us"):
        kind = "client" if verb == "uc" else "speaker"
        await _review_cli(["metric", "upd_client" if verb == "uc" else "upd_speaker", "--op", op])
        await _render_in_place(query, await _review_cli_json(["picker", "--kind", kind, "--id", rq_id, "--f", code, "--page", "0"]))
        return
    if verb == "un":  # add a free-text note: prompt via ForceReply, capture the reply
        await _review_cli(["metric", "upd_note", "--op", op])
        await query.answer()
        try:
            from telegram import ForceReply
            prompt = await query.message.reply_text(
                f"📝 Reply to this message with the note to add to {rq_id}.",
                reply_markup=ForceReply(selective=False),
            )
            _PENDING_NOTES[prompt.message_id] = {
                "rq_id": rq_id,
                "code": code,
                "chat_id": getattr(query.message, "chat_id", None),
                "card_msg_id": getattr(query.message, "message_id", None),
            }
            _gc_pending()
        except Exception:
            logger.exception("review-buttons: note prompt failed")
            try:
                await query.message.reply_text("Couldn't start note capture — use /review for now.")
            except Exception:
                pass
        return
    if verb in ("pc", "ps"):
        kind = "client" if verb == "pc" else "speaker"
        page = arg if (arg and arg.isdigit()) else "0"
        await _render_in_place(query, await _review_cli_json(["picker", "--kind", kind, "--id", rq_id, "--f", code, "--page", page]))
        return
    if verb in ("xc", "xs"):
        if not (arg and arg.isdigit()):
            await query.answer(text="Bad selection.")
            return
        flag = "--client" if verb == "xc" else "--speaker"
        await _render_in_place(query, await _review_cli_json(["update", "--id", rq_id, flag, arg, "--f", code]))
        return

    # ── legacy digest buttons + Jobber-writing actions ────────────────────────
    if verb == "show":
        await query.answer()
        out = await _review_cli(["show", rq_id])
        try:
            await query.message.reply_text(f"👁 {rq_id}\n\n{out}")
        except Exception:
            logger.exception("review-buttons: show reply failed")
        return

    if verb == "dismiss":
        if from_card:
            # Card dismiss: archive (no Jobber write), then advance the card in place.
            await asyncio.to_thread(_run_review_cli, ["dismiss", rq_id, "--reason", "dismissed via Telegram button"])
            payload = await _review_cli_json(["card", "--at", rq_id, "--move", "next", "--f", code])
            if payload and not payload.get("answer"):
                payload["answer"] = "🗑 Dismissed"
            await _render_in_place(query, payload)
        else:
            # Legacy digest row: reply, do NOT edit (would clobber sibling items).
            await query.answer(text="Dismissing…")
            out = await _review_cli(["dismiss", rq_id, "--reason", "dismissed via Telegram button"])
            try:
                await query.message.reply_text(f"🗑 {rq_id}\n{out}")
            except Exception:
                logger.exception("review-buttons: dismiss reply failed")
        return

    if verb == "approve":
        # First tap: do NOT write. Two-tap safety.
        if from_card:
            # Card flow: turn the card into a Confirm/Cancel prompt in place.
            await _render_in_place(query, await _review_cli_json(["approve-prompt", "--id", rq_id, "--f", code]))
        else:
            # Legacy digest row: post a SEPARATE confirm message (never edit the
            # shared digest keyboard — that would clobber sibling items).
            await query.answer()
            try:
                await query.message.reply_text(
                    f"⚠️ Approve {rq_id}? This writes the note to Jobber.",
                    reply_markup=_confirm_keyboard(rq_id),
                )
            except Exception:
                logger.exception("review-buttons: approve confirm prompt failed")
        return

    if verb in ("aok", "aokj"):
        # Card confirm: live Jobber write via the approve executor. On ambiguous
        # job routing it returns a job-picker payload (aokj = retry with the
        # picked job number); on success it returns the next card + a receipt.
        await query.answer(text="Approving…")
        args = ["approve-exec", "--id", rq_id, "--f", code]
        if verb == "aokj" and arg and arg.isdigit():
            args += ["--job", arg]
        payload = await _review_cli_json(args)
        if payload and payload.get("receipt"):
            try:
                await query.message.reply_text(f"✅ Approved {rq_id}\n\n{payload['receipt']}"[:3500])
            except Exception:
                logger.exception("review-buttons: approve receipt failed")
        await _apply_edit(query, payload or {"text": "Couldn't render — try again."})
        return

    if verb == "approveok":
        # Legacy two-tap (separate confirm message): write, then strip the buttons.
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


_VALID_TASK_FILTER = {"a", "o", "m"}  # tasks filter codes (all-open / overdue / mine)


def _valid_task_id(cm_id: str) -> bool:
    """cm_<10 hex> or the literal 'first' (digest entry button)."""
    if cm_id == "first":
        return True
    return (
        isinstance(cm_id, str)
        and cm_id.startswith("cm_")
        and 4 <= len(cm_id) <= 40
        and all(c in _VALID_ID_CHARS for c in cm_id)
    )


async def _handle_tasks_callback(adapter, query, data: str) -> None:
    """Route a ``tk:`` callback (tasks card cycler). Same shape as rq:.

    Grammar:
      tk:noop
      tk:<verb>:<F>:<id>              — card buttons (done/dl/sn/skip/next/prev/card/flt)
      tk:setf:<newF>:<id>             — apply a new filter
      tk:<verb>:<F>:<arg>:<id>        — pickers (xd select, pd paginate, sx snooze days)

    All writes are LOCAL ledger mutations (commitments.json) — no external
    system is touched, so single-tap actions are safe here.
    """
    parts = data.split(":")
    verb = parts[1] if len(parts) > 1 else ""

    if verb == "noop":
        await query.answer()
        return

    cm_id = parts[-1] if parts else ""
    if not _valid_task_id(cm_id):
        await query.answer(text="Invalid task id.")
        return
    code = parts[2] if len(parts) >= 4 and parts[2] in _VALID_TASK_FILTER else "a"
    arg = parts[3] if len(parts) >= 5 else None

    authorized, op = _authorize(adapter, query)
    if not authorized:
        await query.answer(text="⛔ Not authorized.")
        return

    # navigation / rendering
    if verb in ("skip", "next"):
        await _render_in_place(query, await _commit_cli_json(["card", "--at", cm_id, "--move", "next", "--f", code, "--op", op]))
        return
    if verb == "prev":
        await _render_in_place(query, await _commit_cli_json(["card", "--at", cm_id, "--move", "prev", "--f", code, "--op", op]))
        return
    if verb in ("card", "setf"):  # setf: code already holds the new filter
        await _render_in_place(query, await _commit_cli_json(["card", "--at", cm_id, "--move", "here", "--f", code, "--op", op]))
        return
    if verb == "flt":
        await _render_in_place(query, await _commit_cli_json(["filter-menu", "--id", cm_id, "--f", code]))
        return
    if verb == "sn":
        await _render_in_place(query, await _commit_cli_json(["snooze-menu", "--id", cm_id, "--f", code]))
        return
    if verb == "dl":
        await _render_in_place(query, await _commit_cli_json(["delegate-picker", "--id", cm_id, "--f", code, "--page", "0"]))
        return
    if verb == "pd":
        page = arg if (arg and arg.isdigit()) else "0"
        await _render_in_place(query, await _commit_cli_json(["delegate-picker", "--id", cm_id, "--f", code, "--page", page]))
        return
    if verb == "cl":  # fix the task's client → client picker
        await _render_in_place(query, await _commit_cli_json(["client-picker", "--id", cm_id, "--f", code, "--page", "0"]))
        return
    if verb == "pc":  # paginate the client picker
        page = arg if (arg and arg.isdigit()) else "0"
        await _render_in_place(query, await _commit_cli_json(["client-picker", "--id", cm_id, "--f", code, "--page", page]))
        return
    if verb == "home":  # Tasks summary + entry buttons (Back target)
        await _render_in_place(query, await _commit_cli_json(["home"]))
        return
    if verb == "reg":  # Register: completed-tasks view, paginated
        page = arg if (arg and arg.isdigit()) else "0"
        await _render_in_place(query, await _commit_cli_json(["register", "--page", page]))
        return
    if verb == "lb":  # Leaderboard: this calendar month's completions
        await _render_in_place(query, await _commit_cli_json(["leaderboard"]))
        return

    # email (two-tap: em renders the draft, emok is the explicit send tap)
    if verb == "em":
        await _render_in_place(query, await _gmail_cli_json(["task-draft", "--id", cm_id, "--op", op, "--f", code]))
        return
    if verb == "emok":
        await _render_in_place(query, await _gmail_cli_json(["task-send", "--id", cm_id, "--op", op, "--f", code]))
        return
    if verb == "emed":  # edit the draft: capture the new text via ForceReply
        await query.answer()
        try:
            from telegram import ForceReply
            prompt = await query.message.reply_text(
                "✏️ Reply to this message with the new email text. "
                "It replaces the body — start the first line with \"Subject:\" to change the subject too.",
                reply_markup=ForceReply(selective=False),
            )
            _PENDING_NOTES[prompt.message_id] = {
                "kind": "email_edit",
                "id": cm_id,
                "code": code,
                "chat_id": getattr(query.message, "chat_id", None),
                "card_msg_id": getattr(query.message, "message_id", None),
            }
            _gc_pending()
        except Exception:
            logger.exception("review-buttons: email edit prompt failed")
        return

    # local ledger writes (single-tap; toast comes back in the payload's answer)
    if verb == "done":
        await _render_in_place(query, await _commit_cli_json(["tdone", "--id", cm_id, "--by", op, "--f", code, "--op", op]))
        return
    if verb == "del":  # cancel a not-real task (no Register/leaderboard entry)
        await _render_in_place(query, await _commit_cli_json(["tdismiss", "--id", cm_id, "--by", op, "--f", code, "--op", op]))
        return
    if verb == "xd":
        if not (arg and arg.isdigit()):
            await query.answer(text="Bad selection.")
            return
        await _render_in_place(query, await _commit_cli_json(["tdelegate", "--id", cm_id, "--person", arg, "--by", op, "--f", code, "--op", op]))
        return
    if verb == "xc":  # pick the corrected client
        if not (arg and arg.isdigit()):
            await query.answer(text="Bad selection.")
            return
        await _render_in_place(query, await _commit_cli_json(["tsetclient", "--id", cm_id, "--client", arg, "--f", code, "--op", op]))
        return
    if verb == "sx":
        days = arg if (arg and arg.isdigit()) else "1"
        await _render_in_place(query, await _commit_cli_json(["tsnooze", "--id", cm_id, "--days", days, "--f", code, "--op", op]))
        return

    await query.answer(text="Unknown action.")


async def _handle_note_reply(adapter, update) -> bool:
    """Consume a text message that replies to a pending 📝 note prompt.

    Returns True if we handled it (caller must NOT pass it to the agent), False
    to fall through to normal text handling.
    """
    msg = getattr(update, "message", None)
    if msg is None:
        return False
    reply_to = getattr(msg, "reply_to_message", None)
    if reply_to is None:
        return False
    pend = _PENDING_NOTES.pop(getattr(reply_to, "message_id", None), None)
    if not pend:
        return False

    # Authorize the note author the same way callbacks are governed.
    from_user = getattr(msg, "from_user", None)
    caller_id = str(getattr(from_user, "id", "") or "")
    chat = getattr(msg, "chat", None)
    authorized = False
    try:
        authorized = adapter._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(msg, "chat_id", None),
            chat_type=(str(getattr(chat, "type", None)) if getattr(chat, "type", None) is not None else None),
            thread_id=(str(getattr(msg, "message_thread_id", None)) if getattr(msg, "message_thread_id", None) is not None else None),
            user_name=getattr(from_user, "first_name", None),
        )
    except Exception:
        logger.exception("review-buttons: note auth check raised; denying")
        authorized = False
    if not authorized:
        try:
            await msg.reply_text("⛔ Not authorized.")
        except Exception:
            pass
        return True  # we solicited this reply — don't leak it to the agent

    text = (getattr(msg, "text", None) or "").strip()
    if not text:
        try:
            await msg.reply_text("Empty reply — nothing changed.")
        except Exception:
            pass
        return True

    kind = pend.get("kind", "review_note")
    code = pend.get("code", "a")
    op = (getattr(from_user, "first_name", None) or caller_id or "unknown")
    if kind == "email_edit":
        payload = await _gmail_cli_json(["task-draft-set", "--id", pend.get("id"), "--op", op, "--text", text, "--f", code])
        confirm_text = "✏️ Draft updated."
    elif kind == "newclient":
        # /newclient reply: parse into a confirmation card (no write yet). There
        # is no pre-existing inline card to edit — the only earlier message is
        # the ForceReply prompt, which can't be turned into a button card via
        # editMessageText — so send the confirm card as a NEW message instead.
        payload = await _client_cli_json(["preview", "--text", text, "--op", op])
        if payload:
            markup = _kbd(payload.get("reply_markup"))
            try:
                await msg.reply_text(payload.get("text", ""), reply_markup=markup, parse_mode=payload.get("parse_mode"))
            except Exception:
                try:
                    await msg.reply_text(payload.get("text", ""), reply_markup=markup)
                except Exception:
                    logger.exception("review-buttons: newclient confirm card send failed")
        else:
            try:
                await msg.reply_text("Couldn't read that — send /newclient to try again.")
            except Exception:
                pass
        return True
    else:
        rq_id = pend.get("rq_id")
        payload = await _review_cli_json(["update", "--id", rq_id, "--note", text, "--f", code])
        confirm_text = "📝 Note added."

    # Refresh the original card in place (the reply is a new message, so we edit
    # the remembered card message id directly via the bot).
    chat_id = pend.get("chat_id")
    card_msg_id = pend.get("card_msg_id")
    if payload and chat_id and card_msg_id:
        bot = getattr(adapter, "_bot", None)
        markup = _kbd(payload.get("reply_markup"))
        if bot is not None:
            try:
                await bot.edit_message_text(
                    chat_id=chat_id, message_id=card_msg_id,
                    text=payload.get("text", ""), reply_markup=markup,
                    parse_mode=payload.get("parse_mode"),
                )
            except Exception:
                try:
                    await bot.edit_message_text(
                        chat_id=chat_id, message_id=card_msg_id,
                        text=payload.get("text", ""), reply_markup=markup,
                    )
                except Exception:
                    logger.debug("review-buttons: card refresh after note skipped")
    try:
        await msg.reply_text(confirm_text)
    except Exception:
        pass
    return True


def _valid_nc_id(s) -> bool:
    """nc_<8 hex> — defensively reject anything else."""
    return (isinstance(s, str) and s.startswith("nc_") and 4 <= len(s) <= 24
            and all(c in _VALID_ID_CHARS for c in s))


async def _handle_newclient_callback(adapter, query, data: str) -> None:
    """Route an ``nc:`` callback (New Client guided create).

    Verbs:
      nc:cancel:<id>   — abandon the draft
      nc:create:<id>   — confirmed: atomic create (Jobber → Drive folder)
      nc:foldr:<id>    — retry the Drive folder after a partial create
    """
    parts = data.split(":")
    verb = parts[1] if len(parts) > 1 else ""
    nc_id = parts[-1] if parts else ""

    if verb == "cancel":
        await query.answer(text="Cancelled")
        try:
            await query.edit_message_text(text="➕ New client — cancelled.")
        except Exception:
            pass
        return

    if not _valid_nc_id(nc_id):
        await query.answer(text="Invalid draft id.")
        return

    authorized, op = _authorize(adapter, query)
    if not authorized:
        await query.answer(text="⛔ Not authorized.")
        return

    if verb == "create":
        await query.answer(text="Creating…")
        payload = await _client_cli_json(["create", "--id", nc_id, "--op", op])
        await _apply_edit(query, payload or {"text": "Couldn't render — try again."})
        return
    if verb == "foldr":
        await query.answer(text="Retrying folder…")
        payload = await _client_cli_json(["retry-folder", "--id", nc_id, "--op", op])
        await _apply_edit(query, payload or {"text": "Couldn't render — try again."})
        return

    await query.answer(text="Unknown action.")


def _valid_inf_id(s) -> bool:
    """inf_<8 hex>."""
    return (isinstance(s, str) and s.startswith("inf_") and 4 <= len(s) <= 24
            and all(c in _VALID_ID_CHARS for c in s))


async def _handle_inference_callback(adapter, query, data: str) -> None:
    """Route an ``if:`` callback — the §4 live confirm-card cycler.

    Verbs: noop · card/skip/next/prev (navigate) · accept (confirm →
    job-context update) · reject (dismiss). All best-effort; edits in place.
    """
    parts = data.split(":")
    verb = parts[1] if len(parts) > 1 else ""
    if verb == "noop":
        await query.answer()
        return
    inf_id = parts[-1] if parts else ""
    if not _valid_inf_id(inf_id):
        await query.answer(text="Invalid id.")
        return
    authorized, op = _authorize(adapter, query)
    if not authorized:
        await query.answer(text="⛔ Not authorized.")
        return
    if verb in ("card", "skip", "next"):
        move = "next" if verb in ("skip", "next") else "here"
        await _render_in_place(query, await _inference_cli_json(["card", "--at", inf_id, "--move", move]))
        return
    if verb == "prev":
        await _render_in_place(query, await _inference_cli_json(["card", "--at", inf_id, "--move", "prev"]))
        return
    if verb == "accept":
        await _render_in_place(query, await _inference_cli_json(["accept", "--id", inf_id, "--op", op]))
        return
    if verb == "reject":
        await _render_in_place(query, await _inference_cli_json(["reject", "--id", inf_id, "--op", op]))
        return
    await query.answer(text="Unknown action.")


def _authorize_msg(adapter, msg) -> bool:
    """Authorize a plain message's author via the gateway's callback check
    (same policy surface as button taps)."""
    from_user = getattr(msg, "from_user", None)
    chat = getattr(msg, "chat", None)
    caller_id = str(getattr(from_user, "id", "") or "")
    try:
        return adapter._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(msg, "chat_id", None),
            chat_type=(str(getattr(chat, "type", None)) if getattr(chat, "type", None) is not None else None),
            thread_id=(str(getattr(msg, "message_thread_id", None)) if getattr(msg, "message_thread_id", None) is not None else None),
            user_name=getattr(from_user, "first_name", None),
        )
    except Exception:
        logger.exception("review-buttons: msg auth check raised; denying")
        return False


# Bot-menu commands handled directly (no agent round-trip), built from the
# manifest. 'render' = run cli+args and send the payload; 'prompt' = send a
# ForceReply and capture the reply. Session plumbing commands (/new, /topic …)
# aren't in the manifest, so they fall through to the original handler.
def _menu_dispatch():
    return {c["cmd"]: c.get("handler", {}) for c in _load_menu() if c.get("cmd")}


async def _handle_menu_command(adapter, msg, handler) -> None:
    """Serve one bot-menu command from its manifest handler dict."""
    htype = handler.get("type")
    if htype == "prompt":
        # Guided flows (e.g. /newclient): ask, then capture the reply.
        try:
            from telegram import ForceReply
            prompt = await msg.reply_text(
                handler.get("prompt", "Reply to continue."),
                parse_mode="Markdown",
                reply_markup=ForceReply(selective=False),
            )
            _PENDING_NOTES[prompt.message_id] = {
                "kind": handler.get("capture", "newclient"),
                "chat_id": getattr(msg, "chat_id", None),
                "card_msg_id": getattr(prompt, "message_id", None),
            }
            _gc_pending()
        except Exception:
            logger.exception("review-buttons: menu prompt failed")
        return

    # 'render': run the manifest's cli+args and post the JSON payload.
    cli = _resolve_cli(handler.get("cli", ""))
    if not cli:
        await msg.reply_text("Couldn't render — try again.")
        return
    payload = await asyncio.to_thread(_run_cli_json, cli, list(handler.get("args", [])))
    if not payload:
        await msg.reply_text("Couldn't render — try again.")
        return
    text = payload.get("text", "")
    markup = _kbd(payload.get("reply_markup"))
    try:
        await msg.reply_text(text, reply_markup=markup, parse_mode=payload.get("parse_mode"))
    except Exception:
        # Markdown parse failure → degrade to plain text rather than silence.
        try:
            await msg.reply_text(text, reply_markup=markup)
        except Exception:
            logger.exception("review-buttons: menu command reply failed")


def _install_command_wrap() -> bool:
    """Wrap TelegramAdapter._handle_command to serve the bot-menu work commands.

    Same pattern as the other wraps: idempotent, exception-guarded, and
    anything we don't explicitly handle falls through to the original.
    """
    try:
        from gateway.platforms.telegram import TelegramAdapter
    except Exception:
        return False
    orig = TelegramAdapter._handle_command
    if getattr(orig, "_rq_cmd_wrapped", False):
        return True

    async def _wrapped_cmd(self, update, context):  # noqa: ANN001
        try:
            msg = getattr(update, "message", None) or getattr(update, "edited_message", None)
            text = (getattr(msg, "text", None) or "").strip()
            if msg is not None and text.startswith("/"):
                cmd = text.split()[0][1:].split("@")[0].lower()
                handler = _menu_dispatch().get(cmd)
                if handler:
                    if not _authorize_msg(self, msg):
                        return  # silently ignore in unauthorized chats
                    return await _handle_menu_command(self, msg, handler)
        except Exception:
            logger.exception("review-buttons: command wrap raised; deferring to original")
        return await orig(self, update, context)

    _wrapped_cmd._rq_cmd_wrapped = True  # type: ignore[attr-defined]
    TelegramAdapter._handle_command = _wrapped_cmd
    logger.info("review-buttons: installed bot-menu command handler")
    return True


def _install_text_wrap() -> bool:
    """Wrap TelegramAdapter._handle_text_message to capture 📝 note replies.

    Mirrors the callback wrap: idempotent, exception-guarded, and falls straight
    through to the original handler for anything that isn't a pending note reply.
    """
    try:
        from gateway.platforms.telegram import TelegramAdapter
    except Exception:
        return False
    orig = TelegramAdapter._handle_text_message
    if getattr(orig, "_rq_note_wrapped", False):
        return True

    async def _wrapped_text(self, update, context):  # noqa: ANN001
        try:
            if await _handle_note_reply(self, update):
                return
        except Exception:
            logger.exception("review-buttons: note text wrap raised; deferring to original")
        return await orig(self, update, context)

    _wrapped_text._rq_note_wrapped = True  # type: ignore[attr-defined]
    TelegramAdapter._handle_text_message = _wrapped_text
    logger.info("review-buttons: installed note-reply text handler")
    return True


# The guided-workflow menu items, pinned to the top of the bot menu — sourced
# from the manifest (telegram-menu.json) so they never drift from dispatch.
# Hermes rebuilds the Telegram menu from hermes_cli.commands.telegram_menu_commands
# on EVERY gateway start (all scopes + lazy per-chat re-registration), so a
# one-shot setMyCommands gets clobbered on the next restart. Patching the
# source function instead means Hermes itself registers our items, in every
# scope, on every boot — genuinely self-healing.
def _work_menu():
    return [(c["cmd"], c.get("desc", c["cmd"])) for c in _load_menu() if c.get("cmd")]


def _install_menu_wrap() -> bool:
    """Patch telegram_menu_commands so the work commands lead the bot menu."""
    try:
        import hermes_cli.commands as hc
    except Exception:
        logger.debug("review-buttons: hermes_cli.commands not importable; skipping menu wrap")
        return False
    orig = hc.telegram_menu_commands
    if getattr(orig, "_rq_menu_wrapped", False):
        return True

    def _wrapped_menu(max_commands: int = 100):
        try:
            cmds, hidden = orig(max_commands=max_commands)
        except Exception:
            cmds, hidden = [], 0
        work = _work_menu()
        work_names = {n for n, _ in work}
        merged = list(work) + [(n, d) for (n, d) in cmds if n not in work_names]
        if len(merged) > max_commands:
            hidden += len(merged) - max_commands
            merged = merged[:max_commands]
        return merged, hidden

    _wrapped_menu._rq_menu_wrapped = True  # type: ignore[attr-defined]
    hc.telegram_menu_commands = _wrapped_menu
    logger.info("review-buttons: installed work-menu commands wrap")
    return True


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
            if data.startswith("tk:"):
                return await _handle_tasks_callback(self, query, data)
            if data.startswith("nc:"):
                return await _handle_newclient_callback(self, query, data)
            if data.startswith("if:"):
                return await _handle_inference_callback(self, query, data)
        except Exception:
            # Never let our code break inbound handling — fall through to original.
            logger.exception("review-buttons: rq/tk handler raised; deferring to original")
        return await orig(self, update, context)

    _wrapped._rq_wrapped = True  # type: ignore[attr-defined]
    TelegramAdapter._handle_callback_query = _wrapped
    logger.info("review-buttons: installed rq:*/tk:* callback handler")
    return True


def register(ctx) -> None:  # noqa: ANN001 — Hermes plugin entrypoint
    """Plugin entrypoint — runs at gateway/CLI startup."""
    try:
        _install_wrap()
    except Exception:
        logger.exception("review-buttons: failed to install callback wrap")
    try:
        _install_text_wrap()
    except Exception:
        logger.exception("review-buttons: failed to install note-reply text wrap")
    try:
        _install_command_wrap()
    except Exception:
        logger.exception("review-buttons: failed to install bot-menu command wrap")
    try:
        _install_menu_wrap()
    except Exception:
        logger.exception("review-buttons: failed to install work-menu wrap")
