#!/usr/bin/env python3
"""Actions-only synthetic cgroup probe; this is not a qualification receipt."""
import os
import select
import sys
import time
from pathlib import Path


def populated(group):
    events = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
    if events.get("populated") not in ("0", "1"):
        raise RuntimeError("ambiguous cgroup.events")
    return events["populated"]


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("refusing outside a GitHub-hosted Actions runner")
    if os.geteuid() != 0:
        raise RuntimeError("expected a delegated systemd scope running as root")
    memberships = Path("/proc/self/cgroup").read_text().splitlines()
    paths = [line[3:] for line in memberships if line.startswith("0::/")]
    if len(paths) != 1 or "fixture-cgroup-" not in paths[0]:
        raise RuntimeError("not in the expected exclusive systemd scope")
    mount = Path("/sys/fs/cgroup")
    scope = mount / paths[0].lstrip("/")
    if not (mount / "cgroup.controllers").is_file() or not (scope / "cgroup.events").is_file():
        raise RuntimeError("unified cgroup v2 scope unavailable")
    group = scope / "synthetic-phase"
    group.mkdir()  # Refuse reuse; never clean up a pre-existing directory.
    child = None
    gate_read = gate_write = ready_read = ready_write = None
    try:
        leaf = group / "leaf"
        leaf.mkdir()
        nested = leaf / "nested"
        nested.mkdir()
        if populated(group) != "0":
            raise RuntimeError("new phase is unexpectedly populated")
        gate_read, gate_write = os.pipe()
        ready_read, ready_write = os.pipe()
        child = os.fork()
        if child == 0:
            try:
                os.close(gate_write)
                os.close(ready_read)
                if os.read(gate_read, 1) != b"G":
                    os._exit(2)
                if os.fork():
                    os._exit(0)
                os.setsid()
                if os.fork():
                    os._exit(0)
                (nested / "cgroup.procs").write_text(str(os.getpid()))
                os.write(ready_write, b"R")
                while True:
                    signal = os.read(gate_read, 1)
                    if not signal:
                        os._exit(3)
            except BaseException:
                os._exit(4)
        os.close(gate_read)
        gate_read = None
        os.close(ready_write)
        ready_write = None
        (leaf / "cgroup.procs").write_text(str(child))
        if str(child) not in (leaf / "cgroup.procs").read_text().split():
            raise RuntimeError("gated child placement not independently observed")
        os.write(gate_write, b"G")
        if not select.select([ready_read], [], [], 5)[0] or os.read(ready_read, 1) != b"R":
            raise RuntimeError("nested descendant did not become ready")
        _, status = os.waitpid(child, 0)
        child = None
        if status != 0 or populated(group) != "1" or populated(nested) != "1":
            raise RuntimeError("nested survivor or recursive population not observed")
        print("observed: gated placement; orphaned setsid descendant; recursive populated=1", flush=True)
        (group / "cgroup.kill").write_text("1")
        deadline = time.monotonic() + 5
        while populated(group) != "0":
            if time.monotonic() >= deadline:
                raise RuntimeError("recursive populated=0 not observed within cleanup budget")
            time.sleep(0.05)
        print("observed: cgroup.kill followed by recursive populated=0", flush=True)
    finally:
        if gate_write is not None:
            os.close(gate_write)
        if child is not None:
            try:
                os.kill(child, 9)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        for fd in (gate_read, ready_read, ready_write):
            if fd is not None:
                os.close(fd)
        # Only this freshly created subtree is ours. Failure remains a failed probe.
        (group / "cgroup.kill").write_text("1")
        for directory in (group / "leaf" / "nested", group / "leaf", group):
            if directory.exists():
                directory.rmdir()
    print("probe complete; no namespace/reaper, runtime, bridge, or qualification claim")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"capability probe failed closed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
