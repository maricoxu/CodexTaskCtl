"""Tests for the conversational task-plan contract."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import remctl_mcp
from remctl_task_plan import handle_task_plan_tool, normalize_operation
from test_mcp_server import FakeExecutor, make_server, modern_meta, request


class ScriptedExecutor(FakeExecutor):
    def __init__(self):
        super().__init__()
        self.created = 0

    def run(self, key, argv, *, timeout, stdin_text=None):
        self.calls.append({"key": key, "argv": list(argv), "timeout": timeout, "stdin": stdin_text})
        if argv[0] == "lists":
            payload = {"items": [{"id": 2, "title": "收集箱"}], "count": 1}
        elif argv[0] == "search":
            payload = {"items": [{"id": 9, "title": "已有任务", "list": "收集箱"}], "count": 1, "total": 1, "hasMore": False}
        elif argv[0] in {"add", "edit"}:
            self.created += 1
            payload = {"status": "created" if argv[0] == "add" else "updated", "id": 100 + self.created}
        else:
            payload = {}
        return remctl_mcp.CommandResult(list(argv), 0, json.dumps(payload, ensure_ascii=False), "")


class TaskPlanContractTests(unittest.TestCase):
    def test_operation_normalization_rejects_unsafe_updates(self):
        with self.assertRaisesRegex(Exception, "update needs"):
            normalize_operation({"action": "update", "reminder_id": 4}, 0)
        operation = normalize_operation({"action": "create", "title": "x", "priority": 1, "subtasks": ["a"]}, 0)
        self.assertEqual(operation["priority"], "high")
        self.assertEqual(operation["subtasks"], ["a"])

    def test_preview_finds_duplicates_and_persists_confirmation(self):
        executor = ScriptedExecutor()
        with tempfile.TemporaryDirectory() as tmp:
            result = handle_task_plan_tool(
                "preview_task_plan",
                {"idempotency_key": "plan-key-1", "operations": [json.dumps({"action": "create", "title": "已有任务"})]},
                executor=executor, request_key="preview", config_dir=Path(tmp),
            )
            self.assertFalse(result["isError"])
            structured = result["structuredContent"]
            self.assertTrue(structured["requires_confirmation"])
            self.assertEqual(structured["duplicates"][0]["matches"][0]["id"], 9)
            state = json.loads((Path(tmp) / "task-plans.json").read_text())
            self.assertIn(structured["plan_id"], state["plans"])

    def test_apply_requires_confirmation_and_is_idempotent(self):
        executor = ScriptedExecutor()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            preview = handle_task_plan_tool(
                "preview_task_plan",
                {"idempotency_key": "plan-key-2", "operations": [json.dumps({"action": "create", "title": "新任务", "priority": "high"})]},
                executor=executor, request_key="preview", config_dir=root,
            )["structuredContent"]
            denied = handle_task_plan_tool(
                "apply_task_plan",
                {"plan_id": preview["plan_id"], "confirmation_token": preview["confirmation_token"], "confirmed": False},
                executor=executor, request_key="apply", config_dir=root,
            )
            self.assertTrue(denied["isError"])
            applied = handle_task_plan_tool(
                "apply_task_plan",
                {"plan_id": preview["plan_id"], "confirmation_token": preview["confirmation_token"], "confirmed": True},
                executor=executor, request_key="apply", config_dir=root,
            )
            self.assertFalse(applied["isError"])
            self.assertEqual(applied["structuredContent"]["status"], "applied")
            before = len([call for call in executor.calls if call["argv"][0] == "add"])
            replay = handle_task_plan_tool(
                "apply_task_plan",
                {"plan_id": preview["plan_id"], "confirmation_token": preview["confirmation_token"], "confirmed": True},
                executor=executor, request_key="apply-retry", config_dir=root,
            )
            self.assertFalse(replay["isError"])
            self.assertEqual(replay["structuredContent"]["status"], "already_applied")
            self.assertEqual(before, len([call for call in executor.calls if call["argv"][0] == "add"]))

    def test_mcp_catalog_and_dispatch_expose_task_plan_tools(self):
        server, executor = make_server(ScriptedExecutor())
        catalog = request(server, "tools/list", {"_meta": modern_meta()})["result"]["tools"]
        names = {tool["name"] for tool in catalog}
        self.assertTrue({"get_task_context", "preview_task_plan", "apply_task_plan"} <= names)
        result = request(server, "tools/call", {"_meta": modern_meta(), "name": "get_task_context", "arguments": {}})["result"]
        self.assertFalse(result["isError"])
        self.assertIn("items", result["structuredContent"])


if __name__ == "__main__":
    unittest.main()
