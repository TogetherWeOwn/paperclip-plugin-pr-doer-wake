#!/usr/bin/env python3
"""Validate image inspection against a caller-supplied immutable registry digest.

The caller must independently choose a trusted pin, pull by that exact reference,
create the container by the returned image ID, and inspect the same container
before starting it. This check does not establish the provenance of the pin or
make a mutable input bind mount immutable.
"""
import json
import re
import sys


REFERENCE = re.compile(r"[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")


def validate(images, reference):
    if not REFERENCE.fullmatch(reference):
        raise ValueError("expected a digest-pinned registry reference")
    if not isinstance(images, list) or len(images) != 1:
        raise ValueError("expected exactly one inspected image")
    image = images[0]
    image_id = image["Id"]
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        raise ValueError("invalid image ID")
    digests = image["RepoDigests"]
    if not isinstance(digests, list) or reference not in digests:
        raise ValueError("image does not carry the expected registry digest")
    if image["Os"] != "linux" or image["Architecture"] != "amd64":
        raise ValueError("unexpected image platform")
    if image["Config"].get("Volumes"):
        raise ValueError("image declares volumes")
    if image["Config"].get("OnBuild"):
        raise ValueError("image declares ONBUILD instructions")
    return image_id


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: python3 -I inspect-image.py INSPECT.json PINNED_REFERENCE")
    with open(sys.argv[1], encoding="utf-8") as stream:
        print(validate(json.load(stream), sys.argv[2]))


if __name__ == "__main__":
    main()
