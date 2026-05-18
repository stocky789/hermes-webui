import json
import pathlib
import subprocess
import uuid
import urllib.error
import urllib.parse
import urllib.request

import pytest

from tests._pytest_port import BASE


ROOT = pathlib.Path(__file__).parent.parent


def _git(cwd, *args):
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        shell=False,
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return result.stdout


def _init_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init")
    _git(path, "config", "user.email", "hermes-tests@example.invalid")
    _git(path, "config", "user.name", "Hermes Tests")
    return path


def _commit_all(path, message="initial"):
    _git(path, "add", ".")
    _git(path, "commit", "-m", message)


def _get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


def _post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


def _make_session(created_list, ws=None):
    body = {}
    if ws:
        body["workspace"] = str(ws)
    data, status = _post("/api/session/new", body)
    assert status == 200
    sid = data["session"]["session_id"]
    created_list.append(sid)
    return sid, pathlib.Path(data["session"]["workspace"])


def test_git_status_non_git_workspace(tmp_path):
    from api.workspace_git import git_status

    ws = tmp_path / "plain"
    ws.mkdir()
    assert git_status(ws) == {"is_git": False}


def test_git_status_handles_staged_unstaged_untracked_deleted_and_renamed(tmp_path):
    from api.workspace_git import git_status

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    (repo / "delete-me.txt").write_text("bye\n", encoding="utf-8")
    (repo / "old name.txt").write_text("move\n", encoding="utf-8")
    _commit_all(repo)

    (repo / "tracked.txt").write_text("one\ntwo\n", encoding="utf-8")
    (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
    _git(repo, "add", "staged.txt")
    (repo / "delete-me.txt").unlink()
    _git(repo, "mv", "old name.txt", "new name.txt")
    (repo / "untracked space.txt").write_text("new\nfile\n", encoding="utf-8")

    status = git_status(repo)
    by_path = {item["path"]: item for item in status["files"]}

    assert status["is_git"] is True
    assert by_path["tracked.txt"]["unstaged"] is True
    assert by_path["staged.txt"]["staged"] is True
    assert by_path["delete-me.txt"]["status"] == "D"
    assert by_path["new name.txt"]["old_path"] == "old name.txt"
    assert by_path["untracked space.txt"]["untracked"] is True
    assert by_path["untracked space.txt"]["additions"] == 2
    assert status["totals"]["changed"] >= 5


def test_git_status_ignores_crlf_only_worktree_noise(tmp_path):
    from api.workspace_git import git_status

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\ntwo\n", encoding="utf-8", newline="\n")
    _commit_all(repo)

    (repo / "tracked.txt").write_text("one\r\ntwo\r\n", encoding="utf-8", newline="")

    raw = _git(repo, "status", "--porcelain", "--", "tracked.txt")
    assert raw.startswith(" M")

    status = git_status(repo)
    assert status["totals"]["changed"] == 0
    assert status["files"] == []


def test_git_status_keeps_real_edit_with_crlf_endings(tmp_path):
    from api.workspace_git import git_status

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\ntwo\n", encoding="utf-8", newline="\n")
    _commit_all(repo)

    (repo / "tracked.txt").write_text("one\r\ntwo\r\nthree\r\n", encoding="utf-8", newline="")

    status = git_status(repo)
    by_path = {item["path"]: item for item in status["files"]}
    assert status["totals"]["changed"] == 1
    assert by_path["tracked.txt"]["unstaged"] is True
    assert by_path["tracked.txt"]["additions"] == 1
    assert by_path["tracked.txt"]["deletions"] == 0


def test_git_status_ignores_filemode_only_noise(tmp_path):
    from api.workspace_git import git_status

    repo = _init_repo(tmp_path / "repo")
    script = repo / "script.sh"
    script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    _commit_all(repo)

    _git(repo, "update-index", "--chmod=+x", "script.sh")

    raw = _git(repo, "status", "--porcelain", "--", "script.sh")
    assert raw.startswith("M ")

    status = git_status(repo)
    assert status["totals"]["changed"] == 0
    assert status["files"] == []


def test_git_status_scopes_nested_workspace_to_that_directory(tmp_path):
    from api.workspace_git import git_status

    repo = _init_repo(tmp_path / "repo")
    nested = repo / "app"
    nested.mkdir()
    (nested / "inside.txt").write_text("inside\n", encoding="utf-8")
    (repo / "outside.txt").write_text("outside\n", encoding="utf-8")
    _commit_all(repo)

    (nested / "inside.txt").write_text("inside\nchanged\n", encoding="utf-8")
    (repo / "outside.txt").write_text("outside\nchanged\n", encoding="utf-8")

    status = git_status(nested)
    paths = {item["path"] for item in status["files"]}
    assert paths == {"inside.txt"}


def test_git_diff_generates_untracked_text_diff_and_blocks_escape(tmp_path):
    from api.workspace_git import GitWorkspaceError, git_diff

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(repo)
    (repo / "new file.txt").write_text("hello\nworld\n", encoding="utf-8")

    diff = git_diff(repo, "new file.txt", "unstaged")
    assert diff["binary"] is False
    assert "+++ b/new file.txt" in diff["diff"]
    assert "+hello" in diff["diff"]

    with pytest.raises(GitWorkspaceError):
        git_diff(repo, "../outside.txt", "unstaged")


def test_git_status_reports_untracked_files_inside_directories(tmp_path):
    from api.workspace_git import git_discard, git_status

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(repo)
    nested = repo / "newdir"
    nested.mkdir()
    (nested / "a.txt").write_text("hello\n", encoding="utf-8")

    status = git_status(repo)
    paths = {item["path"] for item in status["files"]}
    assert "newdir/a.txt" in paths
    assert "newdir/" not in paths

    git_discard(repo, ["newdir/a.txt"], delete_untracked=True)
    assert not (nested / "a.txt").exists()


def test_git_diff_large_untracked_file_is_bounded(tmp_path):
    from api.workspace_git import DIFF_SIZE_LIMIT, git_diff, git_status

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(repo)
    large = repo / "large.txt"
    large.write_text("x" * (DIFF_SIZE_LIMIT + 1), encoding="utf-8")

    status = git_status(repo)
    by_path = {item["path"]: item for item in status["files"]}
    assert by_path["large.txt"]["untracked"] is True
    assert by_path["large.txt"]["additions"] == 0

    diff = git_diff(repo, "large.txt", "unstaged")
    assert diff["too_large"] is True
    assert diff["diff"] == ""


def test_git_stage_unstage_discard_and_commit(tmp_path):
    from api.workspace_git import git_commit, git_discard, git_stage, git_status, git_unstage

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(repo)

    (repo / "tracked.txt").write_text("one\ntwo\n", encoding="utf-8")
    staged = git_stage(repo, ["tracked.txt"])
    assert staged["totals"]["staged"] == 1

    unstaged = git_unstage(repo, ["tracked.txt"])
    assert unstaged["totals"]["staged"] == 0
    assert unstaged["totals"]["unstaged"] == 1

    git_discard(repo, ["tracked.txt"])
    assert git_status(repo)["totals"]["changed"] == 0

    (repo / "tracked.txt").write_text("one\nthree\n", encoding="utf-8")
    git_stage(repo, ["tracked.txt"])
    committed = git_commit(repo, "Update tracked file")
    assert committed["ok"] is True
    assert committed["commit"]
    assert committed["status"]["totals"]["changed"] == 0


def test_staged_commit_message_prompt_uses_only_staged_diff(tmp_path):
    from api.workspace_git import (
        GitWorkspaceError,
        clean_generated_commit_message,
        staged_commit_message_prompt,
    )

    repo = _init_repo(tmp_path / "repo")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(repo)

    (repo / "tracked.txt").write_text("one\nstaged\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("one\nstaged\nunstaged\n", encoding="utf-8")

    prompt = staged_commit_message_prompt(repo)
    assert prompt["truncated"] is False
    assert "tracked.txt" in prompt["user_prompt"]
    assert "+staged" in prompt["user_prompt"]
    assert "unstaged" not in prompt["user_prompt"]
    assert "Never mention AI, Cursor, Zed, agents" in prompt["system_prompt"]

    _git(repo, "restore", "--staged", "tracked.txt")
    with pytest.raises(GitWorkspaceError):
        staged_commit_message_prompt(repo)

    assert clean_generated_commit_message("```text\nSubject\n\n- Body\n```") == "Subject\n\n- Body"


def test_git_fetch_pull_and_push_with_upstream(tmp_path):
    from api.workspace_git import git_fetch, git_pull, git_push, git_status

    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "--bare", str(remote))

    origin = _init_repo(tmp_path / "origin")
    (origin / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(origin)
    _git(origin, "remote", "add", "origin", str(remote))
    _git(origin, "push", "-u", "origin", "HEAD")

    clone = tmp_path / "clone"
    _git(tmp_path, "clone", str(remote), str(clone))
    _git(clone, "config", "user.email", "hermes-tests@example.invalid")
    _git(clone, "config", "user.name", "Hermes Tests")

    (origin / "tracked.txt").write_text("one\ntwo\n", encoding="utf-8")
    _commit_all(origin, "Remote update")
    _git(origin, "push")

    fetched = git_fetch(clone)
    assert fetched["status"]["behind"] == 1

    pulled = git_pull(clone)
    assert pulled["status"]["behind"] == 0
    assert (clone / "tracked.txt").read_text(encoding="utf-8") == "one\ntwo\n"

    (clone / "tracked.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
    _git(clone, "add", "tracked.txt")
    _git(clone, "commit", "-m", "Local update")
    assert git_status(clone)["ahead"] == 1

    pushed = git_push(clone)
    assert pushed["status"]["ahead"] == 0


def test_git_routes_status_diff_stage_unstage_discard_commit(cleanup_test_sessions):
    sid, base_ws = _make_session(cleanup_test_sessions)
    repo = base_ws / f"git-route-{uuid.uuid4().hex[:8]}"
    _init_repo(repo)
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8")
    _commit_all(repo)

    _post("/api/session/update", {"session_id": sid, "workspace": str(repo), "model": "openai/gpt-5.4-mini"})
    (repo / "tracked.txt").write_text("one\ntwo\n", encoding="utf-8")

    status, code = _get(f"/api/git/status?session_id={sid}")
    assert code == 200
    assert status["git"]["totals"]["unstaged"] == 1

    diff, code = _get(
        f"/api/git/diff?session_id={sid}&path={urllib.parse.quote('tracked.txt')}&kind=unstaged"
    )
    assert code == 200
    assert "+two" in diff["diff"]["diff"]

    staged, code = _post("/api/git/stage", {"session_id": sid, "paths": ["tracked.txt"]})
    assert code == 200 and staged["git"]["totals"]["staged"] == 1

    unstaged, code = _post("/api/git/unstage", {"session_id": sid, "paths": ["tracked.txt"]})
    assert code == 200 and unstaged["git"]["totals"]["unstaged"] == 1

    discarded, code = _post("/api/git/discard", {"session_id": sid, "paths": ["tracked.txt"]})
    assert code == 200 and discarded["git"]["totals"]["changed"] == 0

    (repo / "tracked.txt").write_text("one\nthree\n", encoding="utf-8")
    _post("/api/git/stage", {"session_id": sid, "paths": ["tracked.txt"]})
    committed, code = _post("/api/git/commit", {"session_id": sid, "message": "Route commit"})
    assert code == 200
    assert committed["ok"] is True
    assert committed["status"]["totals"]["changed"] == 0


def test_workspace_git_static_contracts():
    index = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    workspace_js = (ROOT / "static" / "workspace.js").read_text(encoding="utf-8")
    ui_js = (ROOT / "static" / "ui.js").read_text(encoding="utf-8")
    style = (ROOT / "static" / "style.css").read_text(encoding="utf-8")

    for dom_id in [
        "workspaceGitTabs",
        "btnWorkspaceFilesTab",
        "btnWorkspaceChangesTab",
        "gitChangesView",
        "gitChangesList",
        "gitCommitBox",
        "gitCommitMessage",
        "btnGitGenerateCommitMessage",
        "btnGitCommit",
        "gitDiffView",
    ]:
        assert f'id="{dom_id}"' in index

    for fn in [
        "refreshGitStatus",
        "renderGitChanges",
        "openGitDiff",
        "renderGitDiff",
        "stageGitPath",
        "stageGitAllChanges",
        "unstageGitPath",
        "discardGitPath",
        "commitGitChanges",
        "generateGitCommitMessage",
        "runGitRemoteAction",
        "switchWorkspacePanelTab",
    ]:
        assert f"function {fn}" in workspace_js

    discard_body = workspace_js[
        workspace_js.index("async function discardGitPath") : workspace_js.index("async function commitGitChanges")
    ]
    assert "showConfirmDialog" in discard_body
    assert "confirm(" not in discard_body.replace("showConfirmDialog(", "")
    assert "file-git-status" in ui_js
    assert "_gitStageableFiles" in workspace_js
    assert "git-stat-add" in workspace_js and "git-stat-del" in workspace_js
    for cls in [
        ".workspace-tabs",
        ".git-change-row",
        ".git-diff-line",
        ".git-commit-box",
        ".git-stage-all-btn",
        ".git-summary-text",
        ".git-summary-actions",
        ".git-sync-btn",
        ".git-commit-actions",
        ".git-commit-primary",
    ]:
        assert cls in style
    assert ".git-stat-add" in style and ".git-stat-del" in style
    routes = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")
    for route in ["/api/git/fetch", "/api/git/pull", "/api/git/push"]:
        assert route in routes
    assert "/api/git/commit-message" in routes
    assert "`/api/git/${action}`" in workspace_js
    assert "'/api/git/commit-message'" in workspace_js

    for token in [
        'data-i18n="git_files"',
        'data-i18n="git_changes"',
        'data-i18n-placeholder="git_commit_message"',
        'data-i18n="git_commit"',
    ]:
        assert token in index

    i18n = (ROOT / "static" / "i18n.js").read_text(encoding="utf-8")
    for key in [
        "git_files",
        "git_changes",
        "git_stage_all",
        "git_commit_message",
        "git_delete_untracked_confirm",
        "git_fetch",
        "git_pull",
        "git_push",
        "git_sync_failed",
    ]:
        assert i18n.count(f"{key}:") >= 11
