"""Conversation-oriented task planning on top of RemCTL.

This module deliberately keeps the planning layer separate from the RemCTL
CLI parser.  The MCP server can expose the same contract locally, over the
existing bearer-protected HTTP transport, and later behind an OAuth relay.
The model proposes operations; this layer validates, previews, persists a
short-lived confirmation record, and applies only confirmed operations.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Any


PLAN_TTL_SECONDS = 10 * 60
MAX_OPERATIONS = 50
MAX_OPERATION_JSON = 16 * 1024
_STATE_LOCK = threading.RLock()


TASK_PLAN_TOOLS = (
    {
        "name": "get_task_context",
        "title": "Task Context",
        "description": (
            "Read the reminder lists and a bounded set of active reminders for conversational planning. "
            "This is read-only; use it before proposing task changes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for; empty means a broad context scan.", "maxLength": 512},
                "list": {"type": "string", "description": "Optional list name.", "maxLength": 512},
                "list_id": {"type": "integer", "description": "Optional stable numeric list id.", "minimum": 1},
                "limit": {"type": "integer", "description": "Maximum reminders to return.", "minimum": 1, "maximum": 200, "default": 50},
                "include_completed": {"type": "boolean", "description": "Include completed reminders.", "default": False},
            },
            "additionalProperties": False,
        },
        "annotations": {"title": "Task Context", "readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
    },
    {
        "name": "preview_task_plan",
        "title": "Preview Task Plan",
        "description": (
            "Validate proposed reminder operations, find exact-title duplicates, and return a short-lived "
            "confirmation token. It never writes reminders. Each operations item is a JSON object string with "
            "action=create|update, title, reminder_id for update, and optional list/list_id/notes/due/priority/subtasks."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "idempotency_key": {"type": "string", "description": "Stable key for this plan across retries.", "minLength": 8, "maxLength": 200},
                "operations": {"type": "array", "description": "JSON object strings describing create/update operations.", "items": {"type": "string", "maxLength": MAX_OPERATION_JSON}, "minItems": 1, "maxItems": MAX_OPERATIONS},
                "source_context": {"type": "string", "description": "Optional short explanation of the conversation context.", "maxLength": 4000},
            },
            "required": ["idempotency_key", "operations"],
            "additionalProperties": False,
        },
        "annotations": {"title": "Preview Task Plan", "readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
    },
    {
        "name": "apply_task_plan",
        "title": "Apply Task Plan",
        "description": (
            "Apply a previously previewed task plan after explicit user confirmation. Requires plan_id, "
            "confirmation_token, and confirmed=true. The idempotency key prevents duplicate writes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "plan_id": {"type": "string", "description": "Plan id returned by preview_task_plan.", "minLength": 8, "maxLength": 200},
                "confirmation_token": {"type": "string", "description": "Short-lived token returned by preview_task_plan.", "minLength": 8, "maxLength": 200},
                "confirmed": {"type": "boolean", "description": "Must be true after the user confirms the preview.", "default": False},
            },
            "required": ["plan_id", "confirmation_token", "confirmed"],
            "additionalProperties": False,
        },
        "annotations": {"title": "Apply Task Plan", "readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
    },
)

TASK_PLAN_TOOL_NAMES = frozenset(item["name"] for item in TASK_PLAN_TOOLS)


class TaskPlanError(ValueError):
    def __init__(self, code: str, message: str, data: Any | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _error(code: str, message: str, data: Any | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    payload = {"error": error}
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "structuredContent": payload, "isError": True}


def _ok(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "structuredContent": payload, "isError": False}


def _text(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TaskPlanError("invalid_argument", f"{field} must be a non-empty string")
    value = value.strip()
    if len(value) > maximum:
        raise TaskPlanError("invalid_argument", f"{field} exceeds {maximum} characters")
    if "\x00" in value:
        raise TaskPlanError("invalid_argument", f"{field} contains NUL")
    return value


def _optional_text(value: Any, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TaskPlanError("invalid_argument", f"{field} must be a string")
    value = value.strip()
    if len(value) > maximum or "\x00" in value:
        raise TaskPlanError("invalid_argument", f"{field} is invalid")
    return value


def normalize_operation(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TaskPlanError("invalid_operation", f"operation {index + 1} must be an object")
    action = raw.get("action")
    if action not in {"create", "update"}:
        raise TaskPlanError("invalid_operation", f"operation {index + 1} action must be create or update")
    title_value = raw.get("title")
    title = _text(title_value, f"operation {index + 1}.title", 1024) if action == "create" else _optional_text(title_value, f"operation {index + 1}.title", 1024)
    operation: dict[str, Any] = {"action": action}
    if title is not None:
        operation["title"] = title
    if action == "update":
        reminder_id = raw.get("reminder_id")
        if isinstance(reminder_id, bool) or not isinstance(reminder_id, int) or reminder_id < 1:
            raise TaskPlanError("invalid_operation", f"operation {index + 1}.reminder_id must be a positive integer")
        operation["reminder_id"] = reminder_id
    for field, maximum in (("list", 512), ("notes", 16 * 1024), ("due", 128), ("url", 2048), ("reason", 2000)):
        value = _optional_text(raw.get(field), f"operation {index + 1}.{field}", maximum)
        if value is not None:
            operation[field] = value
    if raw.get("list_id") is not None:
        value = raw["list_id"]
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise TaskPlanError("invalid_operation", f"operation {index + 1}.list_id must be a positive integer")
        operation["list_id"] = value
    if "list" in operation and "list_id" in operation:
        raise TaskPlanError("invalid_operation", f"operation {index + 1} may use list or list_id, not both")
    if raw.get("priority") is not None:
        priority = raw["priority"]
        if isinstance(priority, int) and not isinstance(priority, bool):
            priority = "none" if priority == 0 else "high" if 1 <= priority <= 4 else "medium" if priority == 5 else "low" if 6 <= priority <= 9 else None
        if priority not in {"none", "low", "medium", "high"}:
            raise TaskPlanError("invalid_operation", f"operation {index + 1}.priority is invalid")
        operation["priority"] = priority
    subtasks = raw.get("subtasks")
    if subtasks is not None:
        if not isinstance(subtasks, list) or not subtasks or len(subtasks) > 20 or not all(isinstance(item, str) and item.strip() for item in subtasks):
            raise TaskPlanError("invalid_operation", f"operation {index + 1}.subtasks must be 1-20 non-empty strings")
        operation["subtasks"] = [item.strip() for item in subtasks]
    if action == "update" and not any(field in operation for field in ("title", "list", "list_id", "notes", "due", "priority", "url", "subtasks")):
        raise TaskPlanError("invalid_operation", f"operation {index + 1} update needs a field to change")
    operation["operation_id"] = raw.get("operation_id") if isinstance(raw.get("operation_id"), str) and raw["operation_id"].strip() else f"op-{index + 1}"
    return operation


def parse_operations(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list) or not values or len(values) > MAX_OPERATIONS:
        raise TaskPlanError("invalid_argument", f"operations must contain 1-{MAX_OPERATIONS} JSON object strings")
    result = []
    for index, value in enumerate(values):
        if not isinstance(value, str) or len(value) > MAX_OPERATION_JSON:
            raise TaskPlanError("invalid_argument", f"operation {index + 1} must be a JSON string")
        try:
            raw = json.loads(value)
        except (ValueError, RecursionError) as exc:
            raise TaskPlanError("invalid_operation", f"operation {index + 1} is not valid JSON") from exc
        result.append(normalize_operation(raw, index))
    return result


def _state_path(config_dir: Path) -> Path:
    return config_dir / "task-plans.json"


def _load_state(config_dir: Path) -> dict[str, Any]:
    path = _state_path(config_dir)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {"plans": {}, "keys": {}}
    except (OSError, ValueError):
        return {"plans": {}, "keys": {}}


def _save_state(config_dir: Path, state: dict[str, Any]) -> None:
    config_dir.mkdir(parents=True, exist_ok=True)
    path = _state_path(config_dir)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def _run_cli(executor: Any, key: Any, argv: list[str], timeout: float) -> dict[str, Any]:
    result = executor.run((key, uuid.uuid4().hex), argv, timeout=timeout)
    if getattr(result, "timed_out", False):
        raise TaskPlanError("timeout", f"RemCTL command timed out: {' '.join(argv[:2])}")
    if getattr(result, "returncode", 1) != 0:
        message = getattr(result, "stderr", "").strip() or getattr(result, "stdout", "").strip() or "RemCTL command failed"
        raise TaskPlanError("write_failed", message[-4000:])
    try:
        value = json.loads(getattr(result, "stdout", ""))
    except (ValueError, TypeError) as exc:
        raise TaskPlanError("invalid_result", "RemCTL returned non-JSON output") from exc
    return value if isinstance(value, dict) else {"items": value}


def _search(executor: Any, key: Any, operation: dict[str, Any]) -> list[dict[str, Any]]:
    argv = ["search", "--limit", "50", "--offset", "0", "--json", "--", operation["title"]]
    if "list_id" in operation:
        argv[1:1] = ["--list-id", str(operation["list_id"])]
    elif "list" in operation:
        argv[1:1] = ["--list", operation["list"]]
    data = _run_cli(executor, key, argv, 45)
    items = data.get("items", [])
    return items if isinstance(items, list) else []


def _same_title(item: dict[str, Any], title: str) -> bool:
    candidate = str(item.get("title") or item.get("name") or "").strip().casefold()
    return candidate == title.strip().casefold()


def _apply_argv(operation: dict[str, Any]) -> list[str]:
    if operation["action"] == "create":
        argv = ["add"]
    else:
        argv = ["edit", str(operation["reminder_id"])]
    if "list_id" in operation:
        argv += ["--list-id", str(operation["list_id"])]
    elif "list" in operation:
        argv += ["--list", operation["list"]]
    for field, option in (("title", "--title"), ("notes", "--notes"), ("due", "--due"), ("priority", "--priority"), ("url", "--url")):
        if field == "title" and operation["action"] == "create":
            continue
        if field in operation:
            argv += [option, operation[field]]
    if "subtasks" in operation:
        argv.append("--private")
        for subtask in operation["subtasks"]:
            argv += ["--subtask", subtask]
    argv += ["--json", "--", operation["title"]] if operation["action"] == "create" else ["--json"]
    return argv


def _plan_result(plan: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in plan.items() if key not in {"confirmation_token"}}


def handle_task_plan_tool(name: str, arguments: dict[str, Any], *, executor: Any, request_key: Any, config_dir: Path) -> dict[str, Any]:
    try:
        if not isinstance(arguments, dict):
            raise TaskPlanError("invalid_argument", "arguments must be an object")
        if name == "get_task_context":
            limit = arguments.get("limit", 50)
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
                raise TaskPlanError("invalid_argument", "limit must be 1-200")
            if arguments.get("list") is not None and arguments.get("list_id") is not None:
                raise TaskPlanError("invalid_argument", "Pass list or list_id, not both")
            lists = _run_cli(executor, request_key, ["lists", "--json"], 45)
            query = arguments.get("query", "")
            if not isinstance(query, str) or len(query) > 512:
                raise TaskPlanError("invalid_argument", "query must be at most 512 characters")
            argv = ["search", "--limit", str(limit), "--offset", "0"]
            if arguments.get("include_completed"):
                argv.append("--completed")
            if arguments.get("list_id") is not None:
                argv += ["--list-id", str(arguments["list_id"])]
            elif arguments.get("list") is not None:
                argv += ["--list", str(arguments["list"])]
            argv += ["--json", "--", query]
            items = _run_cli(executor, request_key, argv, 45)
            return _ok({"lists": lists.get("items", []), "items": items.get("items", []), "total": items.get("total", items.get("count", 0)), "readOnly": True})
        if name == "preview_task_plan":
            idem = _text(arguments.get("idempotency_key"), "idempotency_key", 200)
            operations = parse_operations(arguments.get("operations"))
            with _STATE_LOCK:
                state = _load_state(config_dir)
                previous = state.get("keys", {}).get(idem)
            if previous and previous.get("status") == "applied":
                return _ok({"status": "already_applied", "idempotency_key": idem, "result": previous.get("result", {})})
            duplicates = []
            for operation in operations:
                if operation["action"] != "create":
                    continue
                matches = [item for item in _search(executor, request_key, operation) if _same_title(item, operation["title"])]
                if matches:
                    duplicates.append({"operation_id": operation["operation_id"], "matches": matches[:10]})
            plan_id = f"plan-{uuid.uuid4().hex}"
            token = secrets.token_urlsafe(24)
            expires = int(time.time()) + PLAN_TTL_SECONDS
            plan = {"plan_id": plan_id, "idempotency_key": idem, "operations": operations, "source_context": _optional_text(arguments.get("source_context"), "source_context", 4000) or "", "duplicates": duplicates, "confirmation_token": token, "expires_at": expires, "status": "awaiting_confirmation"}
            with _STATE_LOCK:
                state.setdefault("plans", {})[plan_id] = plan
                state.setdefault("keys", {})[idem] = {"plan_id": plan_id, "status": "awaiting_confirmation"}
                _save_state(config_dir, state)
            return _ok({**_plan_result(plan), "confirmation_token": token, "requires_confirmation": True})
        if name == "apply_task_plan":
            plan_id = _text(arguments.get("plan_id"), "plan_id", 200)
            token = _text(arguments.get("confirmation_token"), "confirmation_token", 200)
            if arguments.get("confirmed") is not True:
                raise TaskPlanError("confirmation_required", "confirmed=true is required after the user approves the preview")
            with _STATE_LOCK:
                state = _load_state(config_dir)
            plan = state.get("plans", {}).get(plan_id)
            if not isinstance(plan, dict):
                raise TaskPlanError("plan_not_found", "The task plan is not available")
            if plan.get("confirmation_token") != token:
                raise TaskPlanError("invalid_confirmation", "The confirmation token does not match")
            if int(plan.get("expires_at", 0)) < int(time.time()):
                raise TaskPlanError("plan_expired", "The task plan expired; preview it again")
            idem = plan.get("idempotency_key")
            prior = state.get("keys", {}).get(idem, {})
            if prior.get("status") == "applied":
                return _ok({"status": "already_applied", "idempotency_key": idem, "result": prior.get("result", {})})
            prior_results = {item.get("operation_id"): item for item in (plan.get("results") or []) if isinstance(item, dict)}
            result_by_id = dict(prior_results)
            for operation in plan.get("operations", []):
                previous = prior_results.get(operation.get("operation_id"))
                if previous and previous.get("status") == "applied":
                    continue
                try:
                    value = _run_cli(executor, request_key, _apply_argv(operation), 150)
                    result_by_id[operation["operation_id"]] = {"operation_id": operation["operation_id"], "status": "applied", "result": value}
                except TaskPlanError as exc:
                    result_by_id[operation["operation_id"]] = {"operation_id": operation["operation_id"], "status": "uncertain" if exc.code == "timeout" else "failed", "error": {"code": exc.code, "message": exc.message}}
                    break
            results = [result_by_id[operation["operation_id"]] for operation in plan.get("operations", []) if operation["operation_id"] in result_by_id]
            status = "applied" if len(results) == len(plan.get("operations", [])) and all(item["status"] == "applied" for item in results) else "partial"
            result = {"status": status, "plan_id": plan_id, "idempotency_key": idem, "results": results}
            with _STATE_LOCK:
                state.setdefault("keys", {})[idem] = {"plan_id": plan_id, "status": "applied" if status == "applied" else "partial", "result": result}
                plan["status"] = status
                plan["results"] = results
                _save_state(config_dir, state)
            return _ok(result) if status == "applied" else _error("partial_write", "The plan stopped after a failed or uncertain operation; inspect results before retrying", result)
        raise TaskPlanError("unknown_tool", f"Unknown task-plan tool: {name}")
    except TaskPlanError as exc:
        return _error(exc.code, exc.message, exc.data)
