"""Git helpers for the workspace panel.

The browser only sends session ids and workspace-relative paths.  This module
resolves the active workspace server-side, scopes paths before they become Git
pathspecs, and keeps all Git subprocess calls shell-free and bounded.
"""

from __future__ import annotations

import difflib
import os
import shutil
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from api.workspace import safe_resolve_ws


GIT_TIMEOUT = 5
GIT_REMOTE_TIMEOUT = 60
STATUS_FILE_LIMIT = 500
DIFF_SIZE_LIMIT = 512 * 1024
COMMIT_MESSAGE_DIFF_LIMIT = 64 * 1024


class GitWorkspaceError(RuntimeError):
    """User-facing Git operation error."""

    def __init__(self, message: str, code: str = "git_failed"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class GitContext:
    workspace: Path
    repo_root: Path
    workspace_prefix: str


_LOCKS_GUARD = threading.Lock()
_OP_LOCKS: dict[str, threading.Lock] = {}


@contextmanager
def _git_mutation_lock(ctx: GitContext):
    key = str(ctx.repo_root)
    with _LOCKS_GUARD:
        lock = _OP_LOCKS.setdefault(key, threading.Lock())
    if not lock.acquire(timeout=GIT_REMOTE_TIMEOUT):
        raise GitWorkspaceError("Another Git operation is still running", "operation_in_progress")
    try:
        yield
    finally:
        lock.release()


def _classify_git_error(message: str, args: list[str] | None = None) -> str:
    text = (message or "").lower()
    joined = " ".join(args or []).lower()
    if "timed out" in text:
        return "timeout"
    if "not installed" in text or "no such file or directory: 'git'" in text:
        return "missing_git"
    if "not a git repository" in text:
        return "not_a_repo"
    if "outside the workspace" in text or "outside the git repository" in text:
        return "path_outside_workspace"
    if "authentication failed" in text or "permission denied" in text or "could not read username" in text:
        return "auth_failed"
    if "no upstream" in text or "no configured push destination" in text or "has no upstream branch" in text:
        return "no_upstream"
    if "non-fast-forward" in text or "fetch first" in text or "rejected" in text and "push" in joined:
        return "non_fast_forward"
    if "conflict" in text or "unmerged" in text or "merge" in text and "needs" in text:
        return "conflict"
    if "working tree" in text and ("clean" in text or "dirty" in text):
        return "dirty_worktree"
    if "hook" in text:
        return "hook_failed"
    return "git_failed"


def _run_git(
    ctx_or_cwd: GitContext | Path,
    args: list[str],
    *,
    timeout: int = GIT_TIMEOUT,
    check: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    cwd = ctx_or_cwd.repo_root if isinstance(ctx_or_cwd, GitContext) else ctx_or_cwd
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            shell=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitWorkspaceError("Git command timed out", "timeout") from exc
    except FileNotFoundError as exc:
        raise GitWorkspaceError("Git is not installed or not available on PATH", "missing_git") from exc
    except OSError as exc:
        raise GitWorkspaceError(str(exc), _classify_git_error(str(exc), args)) from exc
    if check and result.returncode != 0:
        message = (result.stderr or result.stdout or "Git command failed").strip()
        raise GitWorkspaceError(message, _classify_git_error(message, args))
    return result


def resolve_git_context(workspace: str | Path) -> GitContext | None:
    ws = Path(workspace).expanduser().resolve()
    result = _run_git(ws, ["rev-parse", "--show-toplevel"], check=False)
    if result.returncode != 0:
        return None
    repo_root = Path(result.stdout.strip()).resolve()
    try:
        prefix = ws.relative_to(repo_root).as_posix()
    except ValueError:
        return None
    return GitContext(workspace=ws, repo_root=repo_root, workspace_prefix="" if prefix == "." else prefix)


def _workspace_pathspec(ctx: GitContext) -> str:
    return ctx.workspace_prefix or "."


def _repo_rel(ctx: GitContext, workspace_rel: str) -> str:
    try:
        target = safe_resolve_ws(ctx.workspace, workspace_rel or ".")
    except ValueError as exc:
        raise GitWorkspaceError(str(exc), "path_outside_workspace") from exc
    try:
        repo_rel = target.relative_to(ctx.repo_root).as_posix()
    except ValueError as exc:
        raise GitWorkspaceError("Path is outside the Git repository", "path_outside_workspace") from exc
    if ctx.workspace_prefix:
        try:
            target.relative_to(ctx.workspace)
        except ValueError as exc:
            raise GitWorkspaceError("Path is outside the workspace", "path_outside_workspace") from exc
    return repo_rel


def _workspace_rel(ctx: GitContext, repo_rel: str) -> str | None:
    repo_rel = repo_rel.replace("\\", "/")
    if not ctx.workspace_prefix:
        return repo_rel
    prefix = ctx.workspace_prefix.rstrip("/") + "/"
    if repo_rel == ctx.workspace_prefix:
        return "."
    if repo_rel.startswith(prefix):
        return repo_rel[len(prefix) :]
    return None


def _empty_status() -> dict:
    return {
        "changed": 0,
        "staged": 0,
        "unstaged": 0,
        "untracked": 0,
        "conflicts": 0,
    }


def _status_code(xy: str, *, untracked: bool = False, renamed: bool = False) -> str:
    if untracked:
        return "??"
    if xy in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}:
        return xy
    if renamed:
        return "R"
    for ch in xy:
        if ch in "MADRCUT":
            return ch
    return xy.strip(".") or "M"


def _parse_numstat(text: str, ctx: GitContext) -> dict[str, tuple[int, int, bool]]:
    stats: dict[str, tuple[int, int, bool]] = {}
    for line in text.splitlines():
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        raw_add, raw_del, raw_path = parts
        binary = raw_add == "-" or raw_del == "-"
        additions = 0 if binary else int(raw_add or "0")
        deletions = 0 if binary else int(raw_del or "0")
        workspace_path = _workspace_rel(ctx, raw_path)
        if workspace_path is None:
            continue
        stats[workspace_path] = (additions, deletions, binary)
    return stats


def _parse_path_list(text: str, ctx: GitContext) -> set[str]:
    paths: set[str] = set()
    for raw_path in text.split("\0"):
        if not raw_path:
            continue
        workspace_path = _workspace_rel(ctx, raw_path)
        if workspace_path is not None:
            paths.add(workspace_path)
    return paths


def _collect_diff_paths(ctx: GitContext, cached: bool) -> set[str] | None:
    args = ["diff", "--name-only", "-z", "--ignore-cr-at-eol"]
    if cached:
        args.append("--cached")
    args.extend(["--", _workspace_pathspec(ctx)])
    result = _run_git(ctx, args, check=False)
    if result.returncode != 0:
        return None
    return _parse_path_list(result.stdout, ctx)


def _collect_numstat(ctx: GitContext, cached: bool) -> dict[str, tuple[int, int, bool]]:
    args = ["diff", "--numstat", "--ignore-cr-at-eol"]
    if cached:
        args.append("--cached")
    args.extend(["--", _workspace_pathspec(ctx)])
    result = _run_git(ctx, args, check=False)
    if result.returncode != 0:
        return {}
    return _parse_numstat(result.stdout, ctx)


def _count_untracked_file(path: Path) -> tuple[int, int, bool]:
    try:
        if not path.is_file() or path.stat().st_size > DIFF_SIZE_LIMIT:
            return 0, 0, False
    except OSError:
        return 0, 0, False
    try:
        data = path.read_bytes()
    except OSError:
        return 0, 0, False
    if b"\0" in data:
        return 0, 0, True
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return 0, 0, True
    return len(text.splitlines()) or (1 if text else 0), 0, False


def git_status(workspace: str | Path) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        return {"is_git": False}

    result = _run_git(
        ctx,
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--",
            _workspace_pathspec(ctx),
        ],
        check=True,
    )
    staged_stats = _collect_numstat(ctx, cached=True)
    unstaged_stats = _collect_numstat(ctx, cached=False)
    staged_diff_paths = _collect_diff_paths(ctx, cached=True)
    unstaged_diff_paths = _collect_diff_paths(ctx, cached=False)

    branch = ""
    upstream = ""
    ahead = 0
    behind = 0
    files: dict[str, dict] = {}
    filtered_noise = {"filemode_only": 0, "crlf_only": 0}
    tokens = result.stdout.split("\0")
    i = 0
    truncated = False
    while i < len(tokens):
        rec = tokens[i]
        i += 1
        if not rec:
            continue
        if rec.startswith("# "):
            parts = rec.split(" ", 2)
            if len(parts) >= 3 and parts[1] == "branch.head":
                branch = "" if parts[2] == "(detached)" else parts[2]
            elif len(parts) >= 3 and parts[1] == "branch.upstream":
                upstream = parts[2]
            elif len(parts) >= 3 and parts[1] == "branch.ab":
                for bit in parts[2].split():
                    if bit.startswith("+") and bit[1:].isdigit():
                        ahead = int(bit[1:])
                    elif bit.startswith("-") and bit[1:].isdigit():
                        behind = int(bit[1:])
            continue

        old_path = None
        renamed = False
        if rec.startswith("? "):
            xy = "??"
            repo_path = rec[2:]
            untracked = True
        elif rec.startswith("1 "):
            parts = rec.split(" ", 8)
            if len(parts) < 9:
                continue
            xy = parts[1]
            repo_path = parts[8]
            untracked = False
        elif rec.startswith("2 "):
            parts = rec.split(" ", 9)
            if len(parts) < 10:
                continue
            xy = parts[1]
            repo_path = parts[9]
            if i < len(tokens):
                old_path = tokens[i]
                i += 1
            renamed = True
            untracked = False
        elif rec.startswith("u "):
            parts = rec.split(" ", 10)
            if len(parts) < 11:
                continue
            xy = parts[1]
            repo_path = parts[10]
            untracked = False
        else:
            continue

        workspace_path = _workspace_rel(ctx, repo_path)
        if workspace_path is None:
            continue
        old_workspace_path = _workspace_rel(ctx, old_path) if old_path else None
        x = xy[0] if xy else "."
        y = xy[1] if len(xy) > 1 else "."
        conflict = xy in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"} or rec.startswith("u ")
        additions, deletions, binary = 0, 0, False
        for source in (staged_stats, unstaged_stats):
            if workspace_path in source:
                a, d, b = source[workspace_path]
                additions += a
                deletions += d
                binary = binary or b
        if untracked:
            additions, deletions, binary = _count_untracked_file(ctx.workspace / workspace_path)

        staged = (x not in {".", "?"}) and not untracked
        unstaged = (y not in {".", " "}) and not untracked
        if staged and staged_diff_paths is not None and not renamed:
            raw_staged = staged
            staged = workspace_path in staged_diff_paths or (
                old_workspace_path is not None and old_workspace_path in staged_diff_paths
            )
            if raw_staged and not staged:
                filtered_noise["filemode_only"] += 1
        if unstaged and unstaged_diff_paths is not None and not renamed:
            raw_unstaged = unstaged
            unstaged = workspace_path in unstaged_diff_paths or (
                old_workspace_path is not None and old_workspace_path in unstaged_diff_paths
            )
            if raw_unstaged and not unstaged:
                filtered_noise["filemode_only"] += 1
        if not (staged or unstaged or untracked or conflict or renamed):
            continue
        if not (untracked or conflict or renamed or binary) and additions == 0 and deletions == 0:
            filtered_noise["crlf_only"] += 1
            continue

        files[workspace_path] = {
            "path": workspace_path,
            "old_path": old_workspace_path,
            "workspace_path": workspace_path,
            "status": _status_code(xy, untracked=untracked, renamed=renamed),
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
            "conflict": conflict,
            "additions": additions,
            "deletions": deletions,
            "binary": binary,
        }
        if len(files) >= STATUS_FILE_LIMIT:
            truncated = True
            break

    file_list = sorted(files.values(), key=lambda f: (f["path"].lower()))
    totals = _empty_status()
    for item in file_list:
        if item["staged"]:
            totals["staged"] += 1
        if item["unstaged"]:
            totals["unstaged"] += 1
        if item["untracked"]:
            totals["untracked"] += 1
        if item["conflict"]:
            totals["conflicts"] += 1
    totals["changed"] = len(file_list)

    if not branch:
        branch = (_run_git(ctx, ["rev-parse", "--short", "HEAD"], check=False).stdout or "").strip()
    return {
        "is_git": True,
        "branch": branch or "HEAD",
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "totals": totals,
        "files": file_list,
        "truncated": truncated,
        "noise_filtering": {
            **filtered_noise,
            "active": any(filtered_noise.values()),
            "message": (
                "Line-ending-only and filemode-only changes are hidden by default in the workspace panel"
                if any(filtered_noise.values())
                else ""
            ),
        },
    }


def _diff_stats(diff_text: str) -> tuple[int, int]:
    additions = deletions = 0
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            additions += 1
        elif line.startswith("-"):
            deletions += 1
    return additions, deletions


def _synthetic_untracked_diff(path: Path, label: str) -> dict:
    try:
        if not path.is_file():
            raise GitWorkspaceError("Path is not a file")
        if path.stat().st_size > DIFF_SIZE_LIMIT:
            return {
                "binary": False,
                "too_large": True,
                "diff": "",
                "additions": 0,
                "deletions": 0,
            }
    except OSError as exc:
        raise GitWorkspaceError(str(exc)) from exc
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise GitWorkspaceError(str(exc)) from exc
    if b"\0" in data:
        return {"binary": True, "too_large": False, "diff": "", "additions": 0, "deletions": 0}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return {"binary": True, "too_large": False, "diff": "", "additions": 0, "deletions": 0}
    lines = text.splitlines()
    diff_lines = list(
        difflib.unified_diff([], lines, fromfile="/dev/null", tofile=f"b/{label}", lineterm="")
    )
    diff = "\n".join(diff_lines) + ("\n" if diff_lines else "")
    too_large = len(diff.encode("utf-8", errors="replace")) > DIFF_SIZE_LIMIT
    if too_large:
        diff = diff[:DIFF_SIZE_LIMIT]
    additions, deletions = _diff_stats(diff)
    return {
        "binary": False,
        "too_large": too_large,
        "diff": diff,
        "additions": additions,
        "deletions": deletions,
    }


def git_diff(workspace: str | Path, path: str, kind: str = "unstaged") -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository")
    if kind not in {"unstaged", "staged"}:
        raise GitWorkspaceError("kind must be staged or unstaged")
    repo_rel = _repo_rel(ctx, path)
    workspace_rel = _workspace_rel(ctx, repo_rel) or path

    status = git_status(workspace)
    file_state = next((f for f in status.get("files", []) if f.get("path") == workspace_rel), None)
    if kind == "unstaged" and file_state and file_state.get("untracked"):
        payload = _synthetic_untracked_diff(ctx.workspace / workspace_rel, workspace_rel)
        return {"path": workspace_rel, "kind": kind, **payload}

    args = ["diff", "--no-ext-diff", "--unified=3"]
    if kind == "staged":
        args.append("--cached")
    args.extend(["--", repo_rel])
    result = _run_git(ctx, args, check=True)
    diff = result.stdout
    binary = "Binary files " in diff or "GIT binary patch" in diff
    too_large = len(diff.encode("utf-8", errors="replace")) > DIFF_SIZE_LIMIT
    if too_large:
        diff = diff[:DIFF_SIZE_LIMIT]
    additions, deletions = _diff_stats(diff)
    return {
        "path": workspace_rel,
        "kind": kind,
        "binary": binary,
        "too_large": too_large,
        "additions": additions,
        "deletions": deletions,
        "diff": "" if binary else diff,
    }


def _clean_paths(paths: Iterable[str]) -> list[str]:
    cleaned = []
    for path in paths:
        value = str(path or "").strip()
        if value and value not in cleaned:
            cleaned.append(value)
    if not cleaned:
        raise GitWorkspaceError("At least one path is required")
    return cleaned


def _pathspecs(ctx: GitContext, paths: Iterable[str]) -> list[str]:
    return [_repo_rel(ctx, path) for path in _clean_paths(paths)]


def git_stage(workspace: str | Path, paths: Iterable[str]) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        _run_git(ctx, ["add", "--", *_pathspecs(ctx, paths)], check=True)
    return git_status(workspace)


def git_unstage(workspace: str | Path, paths: Iterable[str]) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    specs = _pathspecs(ctx, paths)
    with _git_mutation_lock(ctx):
        result = _run_git(ctx, ["restore", "--staged", "--", *specs], check=False)
        if result.returncode != 0:
            _run_git(ctx, ["reset", "HEAD", "--", *specs], check=True)
    return git_status(workspace)


def git_discard(workspace: str | Path, paths: Iterable[str], *, delete_untracked: bool = False) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        status = git_status(workspace)
        by_path = {f["path"]: f for f in status.get("files", [])}
        for path in _clean_paths(paths):
            repo_rel = _repo_rel(ctx, path)
            workspace_rel = _workspace_rel(ctx, repo_rel) or path
            state = by_path.get(workspace_rel) or by_path.get(workspace_rel.rstrip("/") + "/")
            if state and state.get("conflict"):
                raise GitWorkspaceError("Conflicted files cannot be discarded from this panel", "conflict")
            if state and state.get("untracked"):
                if not delete_untracked:
                    raise GitWorkspaceError("Untracked files require delete_untracked=true")
                target = safe_resolve_ws(ctx.workspace, workspace_rel)
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink(missing_ok=True)
                continue
            _run_git(ctx, ["restore", "--worktree", "--", repo_rel], check=True)
    return git_status(workspace)


COMMIT_MESSAGE_SYSTEM_PROMPT = """When writing commit messages, PR titles, or PR descriptions:

- Inspect the staged diff before suggesting a commit message.
- Do not use vague subjects like "update", "improve", "refine", "misc changes", "fix stuff", or "various changes".
- For large commits, write a concise subject plus a short body with 2-5 bullets summarizing the main areas changed.
- The subject should describe the actual user-facing result or bug fixed, not just broad implementation activity.
- Keep wording short, clear, and natural.
- Never mention AI, Cursor, Zed, agents, or similar tooling in commits, branch names, PR titles, or PR descriptions.
- Never add your own thoughts or questions into the commit message, the commit message is definitive in nature.

Return only the commit message text. Do not wrap it in Markdown fences.
""".strip()


def _staged_diff_text(ctx: GitContext) -> tuple[str, bool]:
    result = _run_git(
        ctx,
        [
            "diff",
            "--cached",
            "--no-ext-diff",
            "--unified=3",
            "--",
            _workspace_pathspec(ctx),
        ],
        check=True,
    )
    diff = result.stdout or ""
    encoded = diff.encode("utf-8", errors="replace")
    if len(encoded) <= COMMIT_MESSAGE_DIFF_LIMIT:
        return diff, False
    return encoded[:COMMIT_MESSAGE_DIFF_LIMIT].decode("utf-8", errors="replace"), True


def _selected_temp_index_env(ctx: GitContext, specs: list[str]) -> tuple[dict[str, str], str]:
    fd, index_path = tempfile.mkstemp(prefix="hermes-webui-git-index-")
    os.close(fd)
    Path(index_path).unlink(missing_ok=True)
    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = index_path
    try:
        head = _run_git(ctx, ["rev-parse", "--verify", "HEAD"], check=False, env=env)
        if head.returncode == 0:
            _run_git(ctx, ["read-tree", "HEAD"], check=True, env=env)
        else:
            _run_git(ctx, ["read-tree", "--empty"], check=True, env=env)
        _run_git(ctx, ["add", "-A", "--", *specs], check=True, env=env)
        return env, index_path
    except Exception:
        Path(index_path).unlink(missing_ok=True)
        raise


def _selected_files(ctx: GitContext, paths: Iterable[str]) -> tuple[list[str], list[str], list[dict]]:
    requested = _clean_paths(paths)
    requested_specs = [_repo_rel(ctx, path) for path in requested]
    workspace_paths = [_workspace_rel(ctx, spec) or path for spec, path in zip(requested_specs, requested)]
    status = git_status(ctx.workspace)
    by_path = {f["path"]: f for f in status.get("files", [])}
    specs: list[str] = []
    selected = []
    for path, repo_rel in zip(workspace_paths, requested_specs):
        state = by_path.get(path)
        if not state:
            continue
        if state.get("conflict"):
            raise GitWorkspaceError("Resolve conflicts before committing selected files", "conflict")
        if state.get("staged") or state.get("unstaged") or state.get("untracked"):
            selected.append(state)
            for spec in (repo_rel, _repo_rel(ctx, state["old_path"]) if state.get("old_path") else ""):
                if spec and spec not in specs:
                    specs.append(spec)
    if len(selected) != len(workspace_paths):
        raise GitWorkspaceError("Selected paths have no committable changes")
    return specs, workspace_paths, selected


def _selected_diff_text(ctx: GitContext, specs: list[str]) -> tuple[str, bool]:
    env, index_path = _selected_temp_index_env(ctx, specs)
    try:
        result = _run_git(
            ctx,
            ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", *specs],
            check=True,
            env=env,
        )
        diff = result.stdout or ""
        encoded = diff.encode("utf-8", errors="replace")
        if len(encoded) <= COMMIT_MESSAGE_DIFF_LIMIT:
            return diff, False
        return encoded[:COMMIT_MESSAGE_DIFF_LIMIT].decode("utf-8", errors="replace"), True
    finally:
        Path(index_path).unlink(missing_ok=True)


def selected_commit_message_prompt(workspace: str | Path, paths: Iterable[str]) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    specs, _workspace_paths, selected_files = _selected_files(ctx, paths)
    diff, truncated = _selected_diff_text(ctx, specs)
    if not diff.strip():
        raise GitWorkspaceError("No selected diff is available")
    status = git_status(workspace)
    file_lines = []
    for item in selected_files[:80]:
        stats = (
            "binary"
            if item.get("binary")
            else f"+{item.get('additions') or 0} -{item.get('deletions') or 0}"
        )
        file_lines.append(f"- {item.get('status') or 'M'} {item.get('path')} ({stats})")
    if len(selected_files) > 80:
        file_lines.append(f"- ... {len(selected_files) - 80} more selected file(s)")
    user_prompt = (
        "Write a commit message for the selected Git diff below.\n\n"
        f"Branch: {status.get('branch') or 'HEAD'}\n"
        f"Selected files ({len(selected_files)}):\n"
        + "\n".join(file_lines)
        + (
            "\n\nDiff was truncated for size; summarize only what is visible.\n"
            if truncated
            else "\n"
        )
        + "\nSelected diff:\n```diff\n"
        + diff
        + "\n```"
    )
    return {
        "system_prompt": COMMIT_MESSAGE_SYSTEM_PROMPT,
        "user_prompt": user_prompt,
        "truncated": truncated,
        "status": status,
    }


def staged_commit_message_prompt(workspace: str | Path) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository")
    status = git_status(workspace)
    if int((status.get("totals") or {}).get("staged") or 0) <= 0:
        raise GitWorkspaceError("Stage changes before generating a commit message")
    diff, truncated = _staged_diff_text(ctx)
    if not diff.strip():
        raise GitWorkspaceError("No staged diff is available")
    staged_files = [f for f in status.get("files", []) if f.get("staged")]
    file_lines = []
    for item in staged_files[:80]:
        stats = (
            "binary"
            if item.get("binary")
            else f"+{item.get('additions') or 0} -{item.get('deletions') or 0}"
        )
        file_lines.append(f"- {item.get('status') or 'M'} {item.get('path')} ({stats})")
    if len(staged_files) > 80:
        file_lines.append(f"- ... {len(staged_files) - 80} more staged file(s)")
    user_prompt = (
        "Write a commit message for the staged Git diff below.\n\n"
        f"Branch: {status.get('branch') or 'HEAD'}\n"
        f"Staged files ({len(staged_files)}):\n"
        + "\n".join(file_lines)
        + (
            "\n\nDiff was truncated for size; summarize only what is visible.\n"
            if truncated
            else "\n"
        )
        + "\nStaged diff:\n```diff\n"
        + diff
        + "\n```"
    )
    return {
        "system_prompt": COMMIT_MESSAGE_SYSTEM_PROMPT,
        "user_prompt": user_prompt,
        "truncated": truncated,
        "status": status,
    }


def clean_generated_commit_message(message: str) -> str:
    text = str(message or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    if (text.startswith('"') and text.endswith('"')) or (
        text.startswith("'") and text.endswith("'")
    ):
        text = text[1:-1].strip()
    return text


def git_commit(workspace: str | Path, message: str) -> dict:
    msg = str(message or "").strip()
    if not msg:
        raise GitWorkspaceError("Commit message is required")
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        _run_git(ctx, ["commit", "-m", msg], timeout=10, check=True)
    sha = _run_git(ctx, ["rev-parse", "--short", "HEAD"], check=True).stdout.strip()
    return {"ok": True, "commit": sha, "status": git_status(workspace)}


def git_commit_selected(workspace: str | Path, message: str, paths: Iterable[str]) -> dict:
    msg = str(message or "").strip()
    if not msg:
        raise GitWorkspaceError("Commit message is required")
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        specs, workspace_paths, _selected_files_list = _selected_files(ctx, paths)
        env, index_path = _selected_temp_index_env(ctx, specs)
        try:
            quiet = _run_git(ctx, ["diff", "--cached", "--quiet", "--", *specs], check=False, env=env)
            if quiet.returncode == 0:
                raise GitWorkspaceError("Selected paths have no committable changes")
            _run_git(ctx, ["commit", "-m", msg], timeout=10, check=True, env=env)
            _run_git(ctx, ["reset", "-q", "HEAD", "--", *specs], check=True)
        finally:
            Path(index_path).unlink(missing_ok=True)
    sha = _run_git(ctx, ["rev-parse", "--short", "HEAD"], check=True).stdout.strip()
    return {"ok": True, "commit": sha, "paths": workspace_paths, "status": git_status(workspace)}


def _branch_name(ctx: GitContext) -> str:
    branch = _run_git(ctx, ["branch", "--show-current"], check=True).stdout.strip()
    if not branch:
        raise GitWorkspaceError("Cannot push from a detached HEAD")
    return branch


def _remote_message(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stdout or result.stderr or "").strip()


def git_fetch(workspace: str | Path) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        result = _run_git(ctx, ["fetch", "--prune"], timeout=GIT_REMOTE_TIMEOUT, check=True)
    return {"ok": True, "message": _remote_message(result), "status": git_status(workspace)}


def git_pull(workspace: str | Path) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        result = _run_git(ctx, ["pull", "--ff-only"], timeout=GIT_REMOTE_TIMEOUT, check=True)
    return {"ok": True, "message": _remote_message(result), "status": git_status(workspace)}


def git_push(workspace: str | Path) -> dict:
    ctx = resolve_git_context(workspace)
    if ctx is None:
        raise GitWorkspaceError("Workspace is not a Git repository", "not_a_repo")
    with _git_mutation_lock(ctx):
        status = git_status(workspace)
        args = ["push"]
        if not status.get("upstream"):
            branch = _branch_name(ctx)
            remotes = _run_git(ctx, ["remote"], check=True).stdout.split()
            if "origin" not in remotes:
                raise GitWorkspaceError("No upstream branch or origin remote is configured", "no_upstream")
            args.extend(["-u", "origin", branch])
        result = _run_git(ctx, args, timeout=GIT_REMOTE_TIMEOUT, check=True)
    return {"ok": True, "message": _remote_message(result), "status": git_status(workspace)}
