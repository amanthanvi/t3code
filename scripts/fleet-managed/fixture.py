#!/usr/bin/env python3
"""Private coordination fixtures: real native archives, Actions artifacts only."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

import release as publisher

# Legacy SSH clients must reach the ownership lease, not refuse a pre-0.1.0 service.
VERSIONS = {"v1": "0.1.8-preview.20261106.9001", "v2": "0.1.8-preview.20261106.9002",
            "fault-v3": "0.1.8-preview.20261106.9003"}
FAULT = "AMAN_PRIVATE_COORDINATION_FIXTURE_PENDING_TRIAL_FAILURE"
ASSETS = ("fixture.json", "source.tar.gz", "source-commit.txt")


def prepare(config, source_release, patch_sha, variant, directory, context_path):
    publisher.version_key(source_release)
    publisher.require(publisher.SHA.fullmatch(patch_sha), "patch_sha must be an exact lowercase 40-hex commit")
    publisher.require(variant in VERSIONS, "unknown fixture variant")
    release = publisher.api(f"repos/{publisher.UPSTREAM}/releases/tags/v{source_release}")
    publisher.require(isinstance(release, dict) and release.get("tag_name") == "v" + source_release
                      and release.get("published_at") and not release.get("draft"), "source release is not published")
    commit = publisher.api(f"repos/{publisher.REPOSITORY}/commits/{patch_sha}")
    publisher.require(isinstance(commit, dict) and commit.get("sha") == patch_sha, "exact patch commit is unavailable")
    publisher.prepare(config, {"version": source_release, "patchSourceCommit": patch_sha}, directory, context_path)
    context = publisher.read_json(context_path)
    context.update(testFixture=True, sourceRelease=source_release, fixtureVariant=variant)
    publisher.write_json(context_path, context)
    return VERSIONS[variant]


def manifest(context):
    publisher.require(context.get("testFixture") is True, "not an explicitly labeled test fixture")
    publisher.version_key(context["sourceRelease"])
    variant = context["fixtureVariant"]
    publisher.require(variant in VERSIONS and context["upstreamVersion"] == VERSIONS[variant], "unexpected preview fixture version")
    for key in ("upstreamSourceCommit", "sourceCommit", "patchSourceCommit", "patchBaseCommit", "publisherCommit"):
        publisher.require(isinstance(context.get(key), str) and publisher.SHA.fullmatch(context[key]), "invalid source identity")
    publisher.require(context.get("distribution") == publisher.DISTRIBUTION
                      and type(context.get("schemaVersion")) is int and context["schemaVersion"] == 1
                      and context.get("buildId") == f"{context['upstreamVersion']}-{context['sourceCommit'][:12]}",
                      "fixture build identity differs from its source")
    return dict(publisher.build_manifest(context), testFixture=True, sourceRelease=context["sourceRelease"], fixtureVariant=variant)


def replace_once(path, before, after, name):
    text = path.read_text()
    publisher.require(text.count(before) == 1, f"{name} anchor changed; fixture source requires review")
    path.write_text(text.replace(before, after))


def seal(directory, context_path):
    directory = Path(directory)
    context = publisher.read_json(context_path)
    variant = context["fixtureVariant"]
    publisher.require(context.get("testFixture") is True and variant in VERSIONS, "not a known test fixture")
    publisher.version_key(context["sourceRelease"])
    context["upstreamVersion"] = VERSIONS[variant]
    if variant == "fault-v3":
        client = directory / "apps/server/src/cloud/serviceLauncherClient.ts"
        replace_once(client, 'pending !== undefined\n      ? exchange(',
                     f'pending !== undefined\n      ? Effect.andThen(Effect.die("{FAULT}"), exchange(', "pending fault")
        replace_once(client, '        )\n      : Effect.succeed(outcome);',
                     '        ))\n      : Effect.succeed(outcome);', "pending fault closing")
    labels = json.dumps({"testFixture": True, "sourceRelease": context["sourceRelease"], "fixtureVariant": variant}, separators=(",", ":"))
    replace_once(directory / "scripts/build-cli-archive.ts", "encodeJsonString(provenance)",
                 "encodeJsonString({ ...provenance, " + labels[1:-1] + " })", "packager fixture metadata")
    publisher.write_json(context_path, context)
    publisher.seal_source(directory, context_path)
    return manifest(publisher.read_json(context_path))


def package(context_path, archive, output, source):
    context = publisher.read_json(context_path)
    expected = manifest(context)
    publisher.require(publisher.archive_manifest(archive, context["upstreamVersion"]) == expected, "archive fixture provenance mismatch")
    publisher.require(publisher.git(source, "rev-parse", "HEAD") == context["sourceCommit"]
                      and not publisher.git(source, "status", "--porcelain", "--untracked-files=no"), "source differs from sealed fixture")
    output = Path(output)
    publisher.require(not output.exists(), "fixture output must not exist")
    output.mkdir(parents=True)
    name = f"t3-{context['upstreamVersion']}-linux-x64.tar.gz"
    shutil.copyfile(archive, output / name)
    with open(output / "source.tar.gz", "wb") as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as compressed:
            compressed.write(publisher.run("git", "archive", "--format=tar", "HEAD", cwd=source))
    (output / "source-commit.txt").write_bytes(publisher.run("git", "cat-file", "commit", "HEAD", cwd=source))
    publisher.write_json(output / "fixture.json", dict(context, platform="linux-x64", officialArtifact=False,
                         archiveSha256=publisher.digest(output / name), sourceArchiveSha256=publisher.digest(output / "source.tar.gz")))
    (output / "SHA256SUMS").write_text("".join(f"{publisher.digest(output / file)}  {file}\n" for file in (name, *ASSETS)))
    verify(output)


def verify(directory):
    directory = Path(directory)
    context = publisher.read_json(directory / "fixture.json")
    expected = manifest(context)
    name = f"t3-{context['upstreamVersion']}-linux-x64.tar.gz"
    publisher.require(context.get("platform") == "linux-x64" and context.get("officialArtifact") is False, "not a private Linux fixture")
    publisher.require(publisher.archive_manifest(directory / name, context["upstreamVersion"]) == expected, "archive fixture provenance mismatch")
    publisher.require(publisher.digest(directory / name) == context["archiveSha256"]
                      and publisher.digest(directory / "source.tar.gz") == context["sourceArchiveSha256"], "fixture asset digest mismatch")
    commit = (directory / "source-commit.txt").read_bytes()
    publisher.require(len(commit) <= 65536 and hashlib.sha1(f"commit {len(commit)}\0".encode() + commit).hexdigest() == context["sourceCommit"],
                      "fixture source commit mismatch")
    with tarfile.open(directory / "source.tar.gz", "r:gz") as source:
        publisher.require(source.pax_headers.get("comment") == context["sourceCommit"], "fixture source archive commit differs")
    sums = "".join(f"{publisher.digest(directory / file)}  {file}\n" for file in (name, *ASSETS))
    publisher.require((directory / "SHA256SUMS").read_text() == sums
                      and {p.name for p in directory.iterdir()} == {name, *ASSETS, "SHA256SUMS"}, "fixture checksums or asset set differ")
    return context


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--published-upstream-version", required=True)
    prepare_parser.add_argument("--patch-sha", required=True)
    prepare_parser.add_argument("--variant", choices=VERSIONS, required=True)
    prepare_parser.add_argument("--config", default=str(Path(__file__).with_name("config.json")))
    for command in (prepare_parser, commands.add_parser("seal"), commands.add_parser("package")):
        command.add_argument("--source", required=True)
        command.add_argument("--context", required=True)
    package_parser = commands.choices["package"]
    package_parser.add_argument("--archive", required=True)
    package_parser.add_argument("--output", required=True)
    commands.add_parser("verify").add_argument("--directory", required=True)
    args = parser.parse_args(argv)
    if args.command == "prepare":
        version = prepare(publisher.config_at(args.config), args.published_upstream_version, args.patch_sha,
                          args.variant, args.source, args.context)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
                stream.write(f"version={version}\n")
    elif args.command == "seal":
        print(json.dumps(seal(args.source, args.context), separators=(",", ":")))
    elif args.command == "package":
        package(args.context, args.archive, args.output, args.source)
    else:
        verify(args.directory)


subprocess_diagnostic = publisher.subprocess_diagnostic


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Fixture build stopped: {type(error).__name__}: " +
              (json.dumps(subprocess_diagnostic(error)) if isinstance(error, subprocess.CalledProcessError) else str(error)), file=sys.stderr)
        sys.exit(1)
