#!/usr/bin/env python3
"""Validate and extract one exact retained package without executing it."""
import hashlib
import io
import json
import pathlib
import re
import sys
import tarfile
import zipfile

PINS = {
    "installed": ("356a733ad1e2aee3b289b4812429b85d7bac29a2", "43831163440", 1,
                  "9d86b1620cfecc52b8b97116d0abbba657b0a902d9e34002bbf697e0dbcc4d5f",
                  "c839010aa32de13ed805e870888e145f3218ed7c549e38c83add4a42439cee7a"),
    "previous": ("2ed5a9840e005c082733135f2b3a395d348ed116", "43776281685", 1,
                 "360a6aba6a269a36adc1deda53d92a96fb8d6ec56736a7fb08969eeb5b76b771",
                 "716d17cb204f60482eb680f616a59312a5fde0df2f954bd1841877e2940a7110"),
}
REQUIRED = {"package.json", "LICENSE", "README.md", "THREAT-MODEL.md", "ACCEPTANCE.md",
            "migrations/001_wake_ledger.sql", "migrations/002_wake_phases.sql",
            "custody-migrations/README.md", "custody-migrations/001_release_lifecycle.sql"}
METADATA = {"SHA256SUMS", "provenance.json", "validation.json", "package-files.json"}
MAX_BYTES = 20 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package_path(name):
    return name in REQUIRED or re.fullmatch(r"dist/[a-z][a-z-]*(?:\.js|\.d\.ts)", name) is not None


def verify(archive, kind, destination):
    source, run, attempt, archive_hash, tgz_hash = PINS[kind]
    archive = pathlib.Path(archive)
    destination = pathlib.Path(destination)
    require(archive.stat().st_size <= MAX_BYTES, "archive exceeds size limit")
    raw = archive.read_bytes()
    require(digest(raw) == archive_hash, "archive digest mismatch")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries = z.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == 5 and len(set(names)) == len(names), "unexpected bundle members")
        tarballs = [name for name in names if re.fullmatch(r"[a-z0-9.-]+\.tgz", name)]
        require(len(tarballs) == 1 and set(names) == METADATA | set(tarballs), "unexpected bundle paths")
        require(sum(entry.file_size for entry in entries) <= MAX_BYTES, "bundle exceeds size limit")
        for entry in entries:
            mode = entry.external_attr >> 16
            require(not entry.is_dir() and (mode & 0o170000) in (0, 0o100000), "non-regular bundle member")
        bundle = {name: z.read(name) for name in names}
    sums = bundle["SHA256SUMS"].decode("utf-8").splitlines()
    parsed = {}
    for line in sums:
        match = re.fullmatch(r"([a-f0-9]{64})  ([a-zA-Z0-9.-]+)", line)
        require(match is not None and match[2] not in parsed, "invalid checksum list")
        parsed[match[2]] = match[1]
    require(set(parsed) == set(names) - {"SHA256SUMS"}, "checksum list mismatch")
    require(all(digest(bundle[name]) == checksum for name, checksum in parsed.items()), "bundle checksum mismatch")
    provenance = json.loads(bundle["provenance.json"])
    require(provenance["sourceSha"] == source and str(provenance["runId"]) == run
            and int(provenance["runAttempt"]) == attempt
            and provenance["repository"] == "TogetherWeOwn/paperclip-plugin-pr-doer-wake", "provenance mismatch")
    tarball = tarballs[0]
    require(provenance["tarball"]["filename"] == tarball and provenance["tarball"]["sha256"] == tgz_hash
            and provenance["tarball"]["size"] == len(bundle[tarball])
            and digest(bundle[tarball]) == tgz_hash, "tarball mismatch")
    require(json.loads(bundle["validation.json"])["result"] == "passed", "package validation did not pass")
    inventory = json.loads(bundle["package-files.json"])
    require(isinstance(inventory, list) and len(inventory) <= 100, "invalid inventory")
    records = {item["path"]: item for item in inventory}
    require(len(records) == len(inventory), "duplicate inventory path")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(bundle[tarball]), mode="r:gz") as tar:
        members = tar.getmembers()
        require(0 < len(members) <= 100 and sum(member.size for member in members) <= MAX_BYTES, "tar size limit")
        for member in members:
            require(member.isfile() and member.name.startswith("package/"), "invalid tar member")
            name = member.name[len("package/"):]
            require(package_path(name) and name not in files, "unexpected or duplicate package path")
            stream = tar.extractfile(member)
            require(stream is not None, "missing tar content")
            files[name] = stream.read(MAX_BYTES + 1)
    require(REQUIRED <= set(files) and set(files) == set(records), "inventory paths mismatch")
    for name, data in files.items():
        require(len(data) == records[name]["size"] and digest(data) == records[name]["sha256"], "inventory digest mismatch")
    pkg = json.loads(files["package.json"])
    require(pkg["name"] == "@togetherweown/paperclip-plugin-pr-doer-wake"
            and pkg["paperclipPlugin"] == {"manifest": "./dist/manifest.js", "worker": "./dist/worker.js"}
            and {"dist/manifest.js", "dist/worker.js"} <= set(files), "package entrypoint mismatch")
    destination.mkdir(parents=False, exist_ok=False)
    for name, data in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(json.dumps({"kind": kind, "sourceSha": source, "runId": run, "attempt": attempt,
                      "archiveSha256": archive_hash, "tarballSha256": tgz_hash, "files": len(files)}))


if __name__ == "__main__":
    require(len(sys.argv) == 4 and sys.argv[1] in PINS, "usage: verify-retained.py installed|previous archive.zip new-directory")
    verify(sys.argv[2], sys.argv[1], sys.argv[3])
