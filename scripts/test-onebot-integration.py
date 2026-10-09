#!/usr/bin/env python3
"""Real container MCP -> native SeaDice regression. Synthetic identities only."""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import time
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


class Client:
    def __init__(self, origin, token):
        self.origin, self.token, self.session = origin, token, None
        self.counter = 0

    def http(self, path, data=None, token=None):
        headers = {"Authorization": "Bearer " + (token or self.token),
                   "Accept": "application/json, text/event-stream"}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.origin + path,
                                     data=None if data is None else json.dumps(data).encode(),
                                     headers=headers)
        with urllib.request.urlopen(req, timeout=45) as response:
            if response.headers.get("Mcp-Session-Id"):
                self.session = response.headers["Mcp-Session-Id"]
            body = response.read(256 * 1024 + 1)
            assert len(body) <= 256 * 1024, "oversized MCP response"
            if not body:
                return None
            if "text/event-stream" in response.headers.get("Content-Type", ""):
                frames = [line[5:].strip() for line in body.decode().splitlines() if line.startswith("data:")]
                assert frames, "empty MCP SSE response"
                return json.loads(frames[-1])
            return json.loads(body)

    def rpc(self, method, params=None, notification=False):
        request = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notification:
            self.counter += 1
            request["id"] = self.counter
        result = self.http("/mcp", request)
        if notification:
            return None
        assert isinstance(result, dict) and "error" not in result, result
        return result["result"]

    def initialize(self):
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "qqbot-container-regression", "version": "1"}})
        self.rpc("notifications/initialized", notification=True)
        assert any(tool["name"] == "call_ws" for tool in self.rpc("tools/list")["tools"])

    def command(self, command, user="11001", group="22001", invocation=None, role=None):
        args = {"backend_id": "sealdice", "request_id": invocation or str(uuid.uuid4()),
                "audience": "group", "payload": command, "user_id": int(user), "group_id": int(group)}
        if role is not None:
            args["group_role"] = role
        result = self.rpc("tools/call", {"name": "call_ws", "arguments": args})
        assert not result.get("isError"), result
        texts = [item["text"] for item in result.get("content", []) if item.get("type") == "text"]
        assert len(texts) == 1, result
        parsed = json.loads(texts[0])
        assert parsed["status"] == "ok", parsed
        assert parsed["request_id"] == args["request_id"] and parsed["backend_id"] == "sealdice"
        assert all(item["audience"] == "group" and item["target_id"] == int(group) for item in parsed["outputs"])
        return parsed


def text(result):
    return "\n".join(item["message"] for item in result["outputs"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge-image", default=os.environ.get("GENSOKYO_TEST_IMAGE", "qqbot-gensokyo:integration"))
    parser.add_argument("--sealdice-image", default=os.environ.get("SEALDICE_TEST_IMAGE", "qqbot-sealdice:integration"))
    parser.add_argument("--qqbot-image", default=os.environ.get("QQBOT_TEST_IMAGE", "dsh-qqbot:onebot-integration"))
    parser.add_argument("--evidence", default="/tmp/qqbot-onebot-integration.json")
    args = parser.parse_args()
    suffix = uuid.uuid4().hex[:12]
    network, sea, bridge = ("qqbot-trpg-" + suffix + part for part in ("-net", "-sea", "-bridge"))
    control_network = "qqbot-trpg-" + suffix + "-control"
    volumes = ["qqbot-trpg-" + suffix + part for part in ("-sea-data", "-bridge-data", "-sea-backups")]
    token, private_token, ws_token = (uuid.uuid4().hex for _ in range(3))
    evidence = {"synthetic_only": True, "checks": [], "results": []}
    try:
        docker("network", "create", "--internal", network)
        # Docker does not publish ports on an internal-only network. The test
        # client uses loopback on a separate control network; SeaDice remains
        # attached only to the isolated OneBot network.
        docker("network", "create", control_network)
        for volume in volumes:
            docker("volume", "create", volume)
        docker("run", "-d", "--name", bridge, "--network", control_network,
               "-p", "127.0.0.1::8090", "-v", volumes[1] + ":/data",
               "-e", "LLM_BRIDGE_ENABLED=true", "-e", "LLM_BRIDGE_DATA_DIR=/data",
               "-e", 'LLM_BRIDGE_MASTER_USER_KEYS=["123456789:fixtureMaster"]',
               "-e", "LLM_BRIDGE_MCP_TOKEN=" + token, "-e", "LLM_BRIDGE_INTERNAL_TOKEN=" + private_token,
               "-e", "ONEBOT_WS_TOKEN=" + ws_token, "-e", "ONEBOT_BACKEND_ID=sealdice",
               "-e", "ONEBOT_WS_URL=ws://sealdice:18081/ws", args.bridge_image)
        docker("network", "connect", "--alias", "gensokyo-mcp", network, bridge)
        address = docker("port", bridge, "8090/tcp").splitlines()[0]
        client = Client("http://" + address, token)
        startup_deadline = time.monotonic() + 20
        while True:
            try:
                initial = client.http("/internal/backends", token=private_token)["backends"]
                assert initial and not any(item["ready"] for item in initial)
                break
            except (OSError, KeyError, ValueError):
                assert time.monotonic() < startup_deadline, "bridge HTTP was blocked by unavailable backend"
                time.sleep(0.25)
        client.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                  "clientInfo": {"name": "startup-regression", "version": "1"}})
        client.rpc("notifications/initialized", notification=True)
        assert not any(item["name"] == "call_ws" for item in client.rpc("tools/list")["tools"])
        # Exceed the original one-shot startup retry window before bringing
        # the backend online. Readiness must recover without a bridge restart.
        time.sleep(6)
        docker("run", "-d", "--name", sea, "--network", network, "--network-alias", "sealdice",
               "-v", volumes[0] + ":/app/data", "-v", volumes[2] + ":/app/backups", "-e", "SEALDICE_LLM_BRIDGE_ENABLED=true",
               "-e", "SEALDICE_ONEBOT_BIND=0.0.0.0:18081", "-e", "ONEBOT_WS_TOKEN=" + ws_token,
               args.sealdice_image)
        client = Client(client.origin, token)
        evidence["checks"].append("bridge HTTP starts without backend and hides tools until negotiation")
        deadline = time.monotonic() + 90
        while True:
            try:
                backends = client.http("/internal/backends", token=private_token)["backends"]
                if any(item["id"] == "sealdice" and item["ready"] and item["version"] == 1 for item in backends):
                    break
            except (OSError, KeyError, ValueError):
                pass
            if time.monotonic() > deadline:
                for name in (sea, bridge):
                    diagnostic = subprocess.run(["docker", "logs", "--tail", "50", name],
                                                capture_output=True, text=True)
                    startup_log = diagnostic.stdout + diagnostic.stderr
                    for credential in (token, private_token, ws_token):
                        startup_log = startup_log.replace(credential, "[redacted]")
                    print(name, startup_log, flush=True)
                raise AssertionError("native SeaDice registration did not become ready")
            time.sleep(0.25)
        client.initialize()
        display_status = client.http("/internal/backends", token=private_token)
        assert "log-display-v1" in display_status.get("capabilities", []), "bridge display capability missing"
        assert any("log-display-v1" in item.get("capabilities", []) for item in display_status["backends"]), "backend display capability missing"
        roll = client.command(".r 1d1")
        assert "1d1" in text(roll) and "1" in text(roll), roll
        evidence["checks"].append("native registration and r1d1")
        evidence["results"].append(roll)
        # Fresh Gensokyo data uses the pinned five-second heartbeat interval.
        # Keep the real socket connected for two heartbeats: lifecycle and
        # transport heartbeats must not be mistaken for rejected commands.
        time.sleep(11)
        sea_log = subprocess.check_output(["docker", "logs", sea], stderr=subprocess.STDOUT, text=True)
        assert "OneBot LLM bridge event rejected: only message events are accepted" not in sea_log, \
            "normal OneBot lifecycle or heartbeat produced a bridge rejection warning"
        assert client.command(".r 1d1")["status"] == "ok"
        evidence["checks"].append("normal lifecycle and periodic heartbeats stay quiet without interrupting commands")
        for forbidden in [".master", ".rhd 1d1", ".set help"]:
            rejected = client.rpc("tools/call", {"name": "call_ws", "arguments": {
                "backend_id": "sealdice", "request_id": str(uuid.uuid4()), "audience": "group",
                "payload": forbidden, "user_id": 11001, "group_id": 22001}})
            assert not rejected.get("isError"), rejected
            terminal = json.loads(rejected["content"][0]["text"])
            assert terminal["status"] == "failed" and not terminal["outputs"], terminal
        assert client.command(".r 1d1")["status"] == "ok"
        evidence["checks"].append("native whitelist rejects management, hidden aliases and non-rule set without blocking next request")
        for user, group, value in [("11001", "22001", 31), ("11002", "22001", 47),
                                   ("11001", "22002", 73), ("11002", "22002", 89)]:
            client.command(".set coc7", user, group, role="owner")
            client.command(".st 力量" + str(value), user, group)
            queried = client.command(".st show 力量", user, group)
            assert str(value) in text(queried), queried
            evidence["results"].append(queried)
        evidence["checks"].append("two users by two groups isolated native state")
        assert "group-role-v1" in next(item for item in backends if item["id"] == "sealdice")["capabilities"]
        role_group = "22003"
        client.command(".set coc7", group=role_group, role="owner")
        for role in ("member", None):
            before = text(client.command(".set info", group=role_group, role=role))
            arguments = {"backend_id": "sealdice", "request_id": str(uuid.uuid4()),
                         "audience": "group", "payload": ".set dnd", "user_id": 11001, "group_id": int(role_group)}
            if role is not None:
                arguments["group_role"] = role
            rejected = client.rpc("tools/call", {"name": "call_ws", "arguments": arguments})
            assert not rejected.get("isError"), rejected
            terminal = json.loads(rejected["content"][0]["text"])
            assert terminal["status"] == "failed" and not terminal["outputs"], terminal
            assert text(client.command(".set info", group=role_group, role=role)) == before
            assert client.command(".r 1d1", group=role_group, role=role)["status"] == "ok"
        client.command(".set dnd", group=role_group, role="admin")
        assert "20" in text(client.command(".set info", group=role_group, role="member"))
        client.command(".set coc7", group=role_group, role="owner")
        assert "100" in text(client.command(".set info", group=role_group))
        role_invocation = str(uuid.uuid4())
        client.command(".r 1d1", group=role_group, invocation=role_invocation, role="member")
        conflict = client.rpc("tools/call", {"name": "call_ws", "arguments": {
            "backend_id": "sealdice", "request_id": role_invocation, "audience": "group",
            "payload": ".r 1d1", "user_id": 11001, "group_id": int(role_group), "group_role": "owner"}})
        assert conflict.get("isError"), "role change reused a persisted request ID"
        evidence["checks"].append("group owner/admin only rule writes, ordinary queries, unknown rejection and role dedup")
        def parallel_query(pair):
            user, group, value = pair
            parallel = Client(client.origin, token)
            parallel.initialize()
            result = parallel.command(".st show 力量", user, group)
            assert str(value) in text(result), result
            return result

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            evidence["results"].extend(pool.map(parallel_query, [
                ("11001", "22001", 31), ("11002", "22001", 47),
                ("11001", "22002", 73), ("11002", "22002", 89)]))
        evidence["checks"].append("concurrent calls and same user across groups remain isolated")
        invocation = str(uuid.uuid4())
        first = client.command(".r 1d1", invocation=invocation)
        second = client.command(".r 1d1", invocation=invocation)
        assert first == second, "dedup result changed"
        evidence["checks"].append("repeat invocation returns identical completed result")
        conflicting = client.rpc("tools/call", {"name": "call_ws", "arguments": {
            "backend_id": "sealdice", "request_id": invocation, "audience": "group",
            "payload": ".r 2d1", "user_id": 11001, "group_id": 22001}})
        assert conflicting.get("isError"), "same invocation accepted different command parameters"
        evidence["checks"].append("same invocation with different parameters is rejected")
        for hidden_command in [".rh 1d1", ".rah 力量", ".rxh 1d1", ".drlh"]:
            rejected = client.rpc("tools/call", {"name": "call_ws", "arguments": {
                "backend_id": "sealdice", "request_id": str(uuid.uuid4()), "audience": "group",
                "payload": hidden_command, "user_id": 11001, "group_id": 22001}})
            terminal = json.loads(rejected["content"][0]["text"])
            assert terminal["status"] == "failed" and not terminal["outputs"], terminal
            assert not terminal.get("private_receipt"), "blocked hidden command created an outbox receipt"
        evidence["checks"].append("all hidden aliases rejected before native execution without private receipts")
        # Persist both game data and dedup state, but never replay an uncertain command.
        docker("restart", "-t", "30", sea)
        docker("restart", "-t", "30", bridge)
        # HostPort was allocated dynamically for this fixture. Some engines
        # allocate a new loopback port on restart; rediscover its current URL.
        address = docker("port", bridge, "8090/tcp").splitlines()[0]
        client.origin = "http://" + address
        client.session = None
        deadline = time.monotonic() + 90
        restart_backends = None
        restart_error = None
        while True:
            try:
                restart_backends = client.http("/internal/backends", token=private_token)["backends"]
                if any(item["ready"] for item in restart_backends):
                    break
            except (OSError, ValueError, KeyError) as error:
                restart_error = {"type": type(error).__name__, "http_status": getattr(error, "code", None)}
            if time.monotonic() >= deadline:
                evidence["restart_backends"] = restart_backends
                evidence["restart_error"] = restart_error
                raise AssertionError("restart did not negotiate fresh connection")
            time.sleep(0.25)
        client.initialize()
        for user, group, value in [("11001", "22001", 31), ("11002", "22001", 47),
                                   ("11001", "22002", 73), ("11002", "22002", 89)]:
            assert str(value) in text(client.command(".st show 力量", user, group))
        assert client.command(".r 1d1", invocation=invocation) == first
        evidence["checks"].append("restart preserves game and completed dedup state")
        # Exercise the remaining approved native handlers in a separate card,
        # so growth and sanity changes cannot alter the isolation fixtures.
        for command in [".set coc7", ".st 力量50 理智50", ".ra 力量", ".rc 力量",
                        ".sc 0/0", ".en 力量", ".pc list"]:
            native = client.command(command, "11003", "22003", role="owner" if command == ".set coc7" else "member")
            assert native["outputs"], (command, native)
            evidence["results"].append(native)
        evidence["checks"].append("native ra rc sc en pc command handlers")
        wrapper_probe = str(Path(__file__).resolve().with_name("test-onebot-wrapper.mjs"))
        wrapper_output = docker("run", "--rm", "--network", network, "--entrypoint", "node",
            "--mount", "type=bind,src=" + wrapper_probe + ",dst=/tmp/test-onebot-wrapper.mjs,readonly",
            "-e", "QQBOT_ONEBOT_ENABLED=true", "-e", "QQBOT_ONEBOT_LOG_ENABLED=true", "-e", "QQBOT_ONEBOT_HIDDEN_ENABLED=false",
            "-e", "QQBOT_ONEBOT_BACKENDS=sealdice",
            "-e", 'QQBOT_ONEBOT_MASTER_USERS=["123456789:fixtureMaster"]', "-e", "QQBOT_ONEBOT_MCP_URL=http://gensokyo-mcp:8090/mcp",
            "-e", "QQBOT_ONEBOT_MCP_TOKEN=" + token, "-e", "QQBOT_ONEBOT_INTERNAL_TOKEN=" + private_token,
            args.qqbot_image, "/tmp/test-onebot-wrapper.mjs")
        wrapper_results = [json.loads(line) for line in wrapper_output.splitlines() if line.startswith('{"result":')]
        assert len(wrapper_results) == 1, "wrapper probe did not return one structured result"
        wrapper_result = wrapper_results[0]
        assert wrapper_result["result"] == "PASS", wrapper_result
        evidence["results"].append(wrapper_result)
        evidence["checks"].append("production qq-bot wrapper authorization to real native backend")
        archives = docker("exec", sea, "find", "/app/backups", "-type", "f", "-name", "*.zip").splitlines()
        assert archives, "native Master backup did not create an archive in its volume"
        with tempfile.TemporaryDirectory(prefix="qqbot-bridge-backup-") as backup_dir:
            archive = str(Path(backup_dir) / "backup.zip")
            docker("cp", sea + ":" + archives[-1], archive)
            with zipfile.ZipFile(archive) as backup:
                assert backup.namelist(), "backup archive was empty"
                assert backup.testzip() is None, "backup archive could not be read completely"
        evidence["checks"].append("native Master backup archive can be fully read")
        def private_command(owner, command):
            result = client.rpc("tools/call", {"name": "call_ws", "arguments": {
                "backend_id": "sealdice", "request_id": str(uuid.uuid4()), "audience": "private",
                "payload": command, "user_key": "123456789:" + owner}})
            assert not result.get("isError"), result
            return json.loads(result["content"][0]["text"])
        assert private_command("fixtureRestartBanTarget", ".r 1d1")["status"] == "ok"
        identity = private_command("fixtureRestartBanTarget", ".userid")
        target = re.search(r"QQ:[0-9]+", text(identity)).group(0)
        assert private_command("fixtureMaster", ".ban add " + target)["status"] == "ok"
        docker("restart", "-t", "30", sea)
        time.sleep(2)
        deadline = time.monotonic() + 90
        while not any(item["ready"] for item in client.http("/internal/backends", token=private_token)["backends"]):
            assert time.monotonic() < deadline, "restart did not restore Master ACL"
            time.sleep(0.25)
        assert private_command("fixtureMaster", ".ban query " + target)["status"] == "ok"
        assert private_command("fixtureRestartBanTarget", ".r 1d1")["status"] == "failed", "ban was not persisted"
        assert private_command("fixtureMaster", ".ban rm " + target)["status"] == "ok"
        docker("restart", "-t", "30", sea)
        time.sleep(2)
        deadline = time.monotonic() + 90
        while not any(item["ready"] for item in client.http("/internal/backends", token=private_token)["backends"]):
            assert time.monotonic() < deadline, "second restart did not restore Master ACL"
            time.sleep(0.25)
        assert private_command("fixtureRestartBanTarget", ".r 1d1")["status"] == "ok"
        evidence["checks"].append("ban persists and Master can query/remove a target after restart")
        assert "123456789:fixtureMaster" in text(private_command("fixtureMaster", ".master list")), \
            "Master list did not expose its configured display identity"
        assert "虚拟" in text(private_command("fixtureRestartBanTarget", ".userid")), \
            "userid still misrepresented the internal virtual ID"
        evidence["checks"].append("virtual identities are explicitly labeled and Master display uses configured identities")

        log_group_key = "123456789:fixtureLogGroup"
        def log_command(command, role="member", group_key=log_group_key, invocation=None):
            request_id = invocation or str(uuid.uuid4())
            reply = client.rpc("tools/call", {"name": "call_ws", "arguments": {
                "backend_id": "sealdice", "request_id": request_id, "audience": "group",
                "user_key": "123456789:fixtureLogOwner", "group_key": group_key,
                "group_role": role, "payload": command}})
            assert not reply.get("isError"), "log MCP protocol failure"
            return json.loads(reply["content"][0]["text"])

        def log_event(event_id, message, *, group_key=log_group_key, kind="message", is_bot=False):
            accepted = client.http("/internal/log/events", {
                "backend_id": "sealdice", "event_id": event_id, "group_key": group_key,
                "user_key": "123456789:__qqbot__" if is_bot else "123456789:fixtureLogOwner",
                "time": int(time.time()), "nickname": "机器人" if is_bot else "测试玩家",
                "text": message, "kind": kind, "is_bot": is_bot}, token=private_token)
            assert accepted.get("accepted") is True, "capture was not durably accepted"

        def claim_artifact(result, group_key=log_group_key, expected_format="md"):
            receipts = result.get("artifact_receipts", [])
            assert result["status"] == "ok" and len(receipts) == 1, "missing successful artifact metadata"
            assert "bytes_base64" not in json.dumps(result), "artifact body leaked into MCP response"
            receipt = receipts[0]
            body = {"backend_id": "sealdice", "request_id": result["request_id"],
                    "receipt": receipt["receipt"], "group_key": group_key}
            wrong = dict(body, group_key="123456789:anotherLogGroup")
            try:
                client.http("/internal/artifacts/claim", wrong, token=private_token)
                raise AssertionError("cross-group artifact claim succeeded")
            except urllib.error.HTTPError as error:
                assert error.code in (400, 403, 404), error.code
            claimed = client.http("/internal/artifacts/claim", body, token=private_token)
            content = base64.b64decode(claimed["bytes_base64"], validate=True)
            assert claimed["filename"].endswith("." + expected_format)
            assert not re.search(r"8[0-9]{15}", claimed["filename"]), "virtual ID leaked in filename"
            assert len(content) == claimed["size"] == receipt["size"]
            assert hashlib.sha256(content).hexdigest() == claimed["sha256"] == receipt["sha256"]
            assert client.http("/internal/artifacts/ack", {
                **body, "delivery_id": claimed["delivery_id"], "status": "sent"}, token=private_token)["ok"]
            try:
                client.http("/internal/artifacts/claim", body, token=private_token)
                raise AssertionError("final artifact was claimable twice")
            except urllib.error.HTTPError as error:
                assert error.code in (404, 409), error.code
            if expected_format == "md":
                # Keep the synthetic fixture export for reader-level visual QA.
                Path(args.evidence).with_suffix(".preview.md").write_bytes(content)
            return content.decode("utf-8")

        for role in ("member", "unknown"):
            if role == "unknown":
                rejected = client.rpc("tools/call", {"name": "call_ws", "arguments": {
                    "backend_id": "sealdice", "request_id": str(uuid.uuid4()), "audience": "group",
                    "user_key": "123456789:fixtureLogOwner", "group_key": log_group_key,
                    "payload": ".log new story"}})
                denied = json.loads(rejected["content"][0]["text"])
            else:
                denied = log_command(".log new story", role=role)
            assert denied["status"] == "failed" and not denied["outputs"], "unauthorized recording started"
        assert log_command(".log new story", role="owner")["status"] == "ok"
        payload = "唯一正文 <script>alert('x')</script>\n第二行 .r 1d1"
        event_id = str(uuid.uuid4())
        # The event timestamp is part of the fingerprint, so preserve it on duplicate.
        captured = {"backend_id": "sealdice", "event_id": event_id, "group_key": log_group_key,
                    "user_key": "123456789:fixtureLogOwner", "time": int(time.time()),
                    "nickname": "测试玩家", "text": payload, "kind": "message", "is_bot": False}
        assert client.http("/internal/log/events", captured, token=private_token)["accepted"]
        assert client.http("/internal/log/events", captured, token=private_token)["accepted"]
        log_event(str(uuid.uuid4()), "历史机器人提及 <@fixtureBot> [@112244](mqqapi://markdown/mention?at_type=1&at_tinyid=112244)")
        display_event = {**captured, "event_id": str(uuid.uuid4()),
                         "text": "提及 <@fixtureLogOwner> <@unknownTarget> <@!unknownTarget> <@fixtureBot> [@显示名](mqqapi://markdown/mention?at_type=1&at_tinyid=112233)",
                         "display": {"author_aliases": ["openid:fixtureLogOwner"], "mentions": [
                             {"target": "openid:fixtureLogOwner", "name": "事件昵称"},
                             {"target": "openid:fixtureBot", "aliases": ["tinyid:112244"], "is_bot": True},
                             {"target": "tinyid:112233", "name": "SDK昵称"}]}}
        assert client.http("/internal/log/events", display_event, token=private_token)["accepted"]
        assert client.http("/internal/log/events", {**display_event, "display": {
            "author_aliases": ["openid:fixtureLogOwner"], "mentions": [
                {"target": "openid:fixtureLogOwner", "name": "不应覆盖"}]}}, token=private_token)["accepted"]
        log_event(str(uuid.uuid4()), "旧事件 <@fixtureLogOwner> <@legacyUnknown>")
        multiline_reply = "公开机器人回复\n\n- 第二段 `命令`\n\n**第三段** *强调* <卡名>\n\n```text\n代码第一行\n代码第二行\n```\n"
        log_event(str(uuid.uuid4()), multiline_reply, is_bot=True)
        log_event(str(uuid.uuid4()), "另一个群的内容", group_key="123456789:fixtureOtherGroup")
        log_event(str(uuid.uuid4()), "采集中断，部分记录未确认。", kind="gap")
        exported = log_command(".log export story")
        md = claim_artifact(exported)
        assert "&lt;script&gt;" in md and "<script>" not in md, "Markdown did not escape message HTML"
        assert "style=" in md and md.count("唯一正文") == 1 and "公开机器人回复" in md
        assert "另一个群的内容" not in md
        assert "SeaDice记录系统" not in md and "采集中断，部分记录未确认。" not in md and "[log gap:" not in md, "system gap diagnostics leaked into Markdown"
        gap_stat = text(log_command(".log stat story"))
        assert re.search(r"已记录缺口：([1-9][0-9]*)", gap_stat), "hidden export markers were removed from diagnostic tracking"
        assert "群组虚拟ID" not in md and not re.search(r"<code>8[0-9]{15}</code>", md)
        assert "@事件昵称" in md and "@SDK昵称" in md and "@机器人" in md
        assert "@测试玩家" in md and "@成员1" in md and "@成员2" in md
        assert "fixtureLogOwner" not in md and "unknownTarget" not in md and "mqqapi://" not in md
        assert "不应覆盖" not in md and md.count("提及 @事件昵称") == 1
        assert "历史机器人提及 @机器人 @机器人" in md, "later trusted bot aliases did not resolve historical mentions"
        body_lines = [line for line in md.splitlines() if line.startswith("<div>")]
        bot_body = next((line for line in body_lines if "公开机器人回复" in line), "")
        assert "<strong>第三段</strong>" in bot_body and "<em>强调</em>" in bot_body and "<code>命令</code>" in bot_body, "bot Markdown lost rich rendering"
        assert "color:" not in bot_body and "代码第二行" in bot_body, "bot body was colored or lost paragraphs"
        assert not re.search(r"<pre style=", md), "Typora-incompatible colored pre body remained"
        evidence["checks"].append("display capability, names, stable anonymous mentions and first-snapshot dedup survive real transport")
        assert log_command(".log off", role="admin")["status"] == "ok"
        log_event(str(uuid.uuid4()), "暂停后不应记录")
        txt = claim_artifact(log_command(".log export story --format=txt"), expected_format="txt")
        assert payload in txt and "暂停后不应记录" not in txt
        assert display_event["text"] in txt and "旧事件 <@fixtureLogOwner> <@legacyUnknown>" in txt
        assert multiline_reply in txt, "Markdown compatibility changed original TXT body"
        assert "SeaDice记录系统" not in txt and "采集中断，部分记录未确认。" not in txt and "[log gap:" not in txt, "system gap diagnostics leaked into TXT"
        assert "群组虚拟ID" not in txt and "virtual:" not in txt
        assert log_command(".log on story", role="admin")["status"] == "ok"
        docker("restart", "-t", "30", sea)
        deadline = time.monotonic() + 90
        while not any(item["ready"] for item in client.http("/internal/backends", token=private_token)["backends"]):
            assert time.monotonic() < deadline, "recording restart failed to reconnect"
            time.sleep(0.25)
        log_event(str(uuid.uuid4()), "重启后的记录")
        md = claim_artifact(log_command(".log get story"))
        assert "重启后的记录" in md and md.count("唯一正文") == 1, "recording state/dedup was not persistent"
        ended = claim_artifact(log_command(".log end", role="owner"))
        assert "重启后的记录" in ended
        assert log_command(".log del story", role="owner")["status"] == "ok"
        assert "story" not in text(log_command(".log list"))
        evidence["checks"].append("native group logs enforce roles, dedup, pause/restart boundaries and current-group isolation")
        evidence["checks"].append("escaped colored Markdown and raw TXT artifacts are body-free in MCP and one-shot claim/ACK scoped")
        profile_probe = str(Path(__file__).resolve().with_name("test-profile-boot.mjs"))
        profile_output = docker("run", "--rm", "--network", network,
            "--mount", "type=bind,src=" + profile_probe + ",dst=/tmp/test-profile-boot.mjs,readonly",
            "-e", "QQBOT_APPID=123456789", "-e", "QQBOT_SECRET=fixture-app-secret",
            "-e", "DEEPSEEK_API_KEY=fixture-official-key",
            "-e", "QQBOT_ONEBOT_ENABLED=true", "-e", "QQBOT_ONEBOT_HIDDEN_ENABLED=false",
            "-e", "QQBOT_ONEBOT_BACKENDS=sealdice",
            "-e", 'QQBOT_ONEBOT_MASTER_USERS=["123456789:fixtureMaster"]', "-e", "QQBOT_ONEBOT_MCP_URL=http://gensokyo-mcp:8090/mcp",
            "-e", "QQBOT_ONEBOT_MCP_TOKEN=" + token, "-e", "QQBOT_ONEBOT_INTERNAL_TOKEN=" + private_token,
            "-e", "QQBOT_TEST_ONEBOT_EXPECT_READY=true",
            args.qqbot_image, "node", "/tmp/test-profile-boot.mjs")
        profile_results = [json.loads(line) for line in profile_output.splitlines() if line.startswith('{"ok":')]
        assert len(profile_results) == 1, "real Harness probe did not return one structured result"
        profile_result = profile_results[0]
        assert profile_result["ok"] is True and "qqbot_onebot_command" in profile_result["modelNames"], profile_result
        evidence["results"].append(profile_result)
        evidence["checks"].append("real Harness catalog and model-facing result from native SeaDice")
        evidence["result"] = "PASS"
        print("OneBot native container integration PASS:", len(evidence["checks"]), "checks")
    except BaseException:
        # SeaDice flushes its log queue asynchronously. Give terminal-stage
        # diagnostics time to reach stdout before collecting/removing fixtures.
        time.sleep(1)
        for name in (sea, bridge):
            state = subprocess.run(["docker", "inspect", "--format",
                                    "exit={{.State.ExitCode}} oom={{.State.OOMKilled}} running={{.State.Running}}", name],
                                   capture_output=True, text=True)
            print(name, state.stdout.strip(), flush=True)
            if name == sea:
                with tempfile.TemporaryDirectory(prefix="qqbot-panic-") as panic_dir:
                    panic_path = Path(panic_dir) / "panic.log"
                    copied = subprocess.run(["docker", "cp", name + ":/app/data/panic.log", str(panic_path)],
                                            capture_output=True, text=True)
                    if copied.returncode == 0:
                        panic_log = panic_path.read_text(encoding="utf-8", errors="replace")[-16000:]
                        for credential in (token, private_token, ws_token):
                            panic_log = panic_log.replace(credential, "[redacted]")
                        print(name, "native panic diagnostic:", panic_log, flush=True)
            diagnostic = subprocess.run(["docker", "logs", "--tail", "80", name],
                                        capture_output=True, text=True)
            runtime_log = diagnostic.stdout + diagnostic.stderr
            secrets = [token, private_token, ws_token]
            if isinstance(locals().get("claim"), dict):
                secrets.extend(item["message"] for item in claim.get("outputs", []))
            for value in secrets:
                runtime_log = runtime_log.replace(value, "[redacted]")
            print(name, runtime_log, flush=True)
        raise
    finally:
        with open(args.evidence, "w", encoding="utf-8") as output:
            json.dump(evidence, output, ensure_ascii=False, indent=2)
        for name in (bridge, sea):
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", control_network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
