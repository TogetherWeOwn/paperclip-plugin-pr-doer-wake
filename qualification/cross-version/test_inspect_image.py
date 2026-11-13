import copy
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("inspect_image", pathlib.Path(__file__).with_name("inspect-image.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InspectImageTest(unittest.TestCase):
    def setUp(self):
        self.reference = "node@sha256:" + "a" * 64
        self.image = {"Id": "sha256:" + "b" * 64, "RepoDigests": [self.reference],
                      "Os": "linux", "Architecture": "amd64", "Config": {}}

    def test_accepts_exact_digest_and_returns_id(self):
        self.assertEqual(module.validate([self.image], self.reference), self.image["Id"])

    def test_rejects_unpinned_reference(self):
        for reference in ("node:24", "node@sha256:short", "NODE@sha256:" + "a" * 64):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                module.validate([self.image], reference)

    def test_rejects_unexpected_inspection(self):
        for key, value in (("Id", "sha256:short"), ("RepoDigests", []),
                           ("Os", "windows"), ("Architecture", "arm64"),
                           ("Config", {"Volumes": {"/input": {}}}),
                           ("Config", {"OnBuild": ["RUN false"]})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                image = copy.deepcopy(self.image)
                image[key] = value
                module.validate([image], self.reference)
        for images in ([], [self.image, self.image], {}):
            with self.subTest(images=images), self.assertRaises(ValueError):
                module.validate(images, self.reference)


if __name__ == "__main__":
    unittest.main()
