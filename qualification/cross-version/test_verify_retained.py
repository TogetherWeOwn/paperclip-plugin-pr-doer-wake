import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("verify_retained", pathlib.Path(__file__).with_name("verify-retained.py"))
verify_retained = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_retained)
v = verify_retained


class RetainedPackageTest(unittest.TestCase):
    def make_bundle(self, *, extra_tar=None, inventory_override=None):
        files = {name: b"synthetic" for name in v.REQUIRED}
        files.update({"dist/manifest.js": b"manifest", "dist/worker.js": b"worker"})
        files["package.json"] = json.dumps({"name": "@togetherweown/paperclip-plugin-pr-doer-wake",
            "paperclipPlugin": {"manifest": "./dist/manifest.js", "worker": "./dist/worker.js"}}).encode()
        inventory = [{"path": name, "size": len(data), "sha256": v.digest(data)} for name, data in files.items()]
        if inventory_override:
            inventory_override(inventory)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for name, data in files.items():
                info = tarfile.TarInfo("package/" + name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            if extra_tar:
                info = tarfile.TarInfo(extra_tar)
                info.size = 1
                tar.addfile(info, io.BytesIO(b"x"))
        tgz = buffer.getvalue()
        provenance = {"sourceSha": "a" * 40, "runId": "123", "runAttempt": 1,
            "repository": "TogetherWeOwn/paperclip-plugin-pr-doer-wake",
            "tarball": {"filename": "package.tgz", "size": len(tgz), "sha256": v.digest(tgz)}}
        contents = {"package.tgz": tgz, "provenance.json": json.dumps(provenance).encode(),
            "validation.json": b'{"result":"passed"}', "package-files.json": json.dumps(inventory).encode()}
        contents["SHA256SUMS"] = "".join(f"{v.digest(data)}  {name}\n" for name, data in contents.items()).encode()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as output:
            for name, data in contents.items():
                output.writestr(name, data)
        data = archive.getvalue()
        v.PINS["test"] = ("a" * 40, "123", 1, v.digest(data), v.digest(tgz))
        return data

    def check(self, data, should_pass):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / "archive.zip"
            archive.write_bytes(data)
            output = pathlib.Path(directory) / "package"
            if should_pass:
                v.verify(archive, "test", output)
                self.assertEqual((output / "dist/worker.js").read_bytes(), b"worker")
                with self.assertRaises(FileExistsError):
                    v.verify(archive, "test", output)
            else:
                with self.assertRaises(ValueError):
                    v.verify(archive, "test", output)
                self.assertFalse(output.exists())

    def test_valid_and_existing_destination(self):
        self.check(self.make_bundle(), True)

    def test_wrong_archive_digest(self):
        archive = self.make_bundle()
        v.PINS["test"] = (*v.PINS["test"][:3], "0" * 64, v.PINS["test"][4])
        self.check(archive, False)

    def test_rejects_traversal_and_duplicate(self):
        for name in ("package/../escape", "package/dist/worker.js"):
            with self.subTest(name=name):
                self.check(self.make_bundle(extra_tar=name), False)

    def test_rejects_inventory_digest_mismatch(self):
        self.check(self.make_bundle(inventory_override=lambda items: items[0].update(sha256="0" * 64)), False)


if __name__ == "__main__":
    unittest.main()
