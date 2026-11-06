#!/usr/bin/env python3
"""Immutable, server-only managed releases; every network mutation is in publish()."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen


NIGHTLY = re.compile(r"^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$")
SHA = re.compile(r"^[0-9a-f]{40}$")
DISTRIBUTION = "aman-t3-managed"
REPOSITORY = "amanthanvi/t3code"
UPSTREAM = "pingdotgg/t3code"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version_key(version):
    match = NIGHTLY.fullmatch(version)
    require(match is not None, "not a canonical nightly version")
    return tuple(map(int, match.groups()))


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def run(*args, cwd=None, env=None, input=None):
    return subprocess.run(args, cwd=cwd, env=env, input=input, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def git(directory, *args, **kwargs):
    return run("git", *args, cwd=directory, **kwargs).decode().strip()


def subprocess_diagnostic(error):
    args = error.cmd if isinstance(error.cmd, (list, tuple)) else ()
    executable = Path(args[0]).name if args and isinstance(args[0], str) else ""
    operation = executable if executable in {"git", "node", "vp", "cargo", "tar", "gh"} else "subprocess"
    if executable == "gh" and len(args) >= 3 and args[1] == "release" and args[2] in {"create", "edit", "verify", "verify-asset"}:
        operation = "gh.release." + args[2]
    elif executable == "gh" and len(args) >= 2 and args[1] == "api":
        operation = "gh.api"
    elif executable == "git" and len(args) >= 2 and args[1] in {
            "clone", "fetch", "merge-base", "diff", "checkout", "apply", "show", "add", "commit",
            "rev-parse", "status", "archive", "cat-file", "ls-remote", "push"}:
        operation = "git." + args[1]
    text = "\n".join(value.decode(errors="replace") if isinstance(value, bytes) else value
                     for value in (error.stdout, error.stderr) if isinstance(value, (bytes, str)))
    codes = sorted(set(re.findall(r"\b(?:unicorn|t3code|eslint)\([a-z][a-z0-9/-]{0,79}\)|\bTS\d{3,7}\b", text)))[:20]
    statuses = re.findall(r"\bHTTP(?:/[\d.]+)?\s+([1-5]\d{2})\b", text, re.I)
    statuses += re.findall(r"[\"']?status(?: code)?[\"']?\s*[:=]\s*[\"']?([1-5]\d{2})\b", text, re.I)
    github_class = None
    if executable in {"gh", "git"}:
        lower = text.lower()
        for classification, needles in (
            ("unsupported_command", ("unknown command", "unknown flag", "unknown shorthand flag", "unknown option", "unrecognized arguments")),
            ("permission_denied", ("resource not accessible", "permission denied", "insufficient permission", "bad credentials", "requires authentication", "forbidden")),
            ("not_found", ("not found",)),
            ("conflict", ("conflict", "already exists", "already_exists")),
            ("validation_failed", ("validation failed", "unprocessable entity")),
        ):
            if any(needle in lower for needle in needles):
                github_class = classification
                break
    return {"operation": operation, "help": "--help" in args[1:], "exitCode": error.returncode,
            "ruleCodes": codes, "httpStatuses": sorted({int(status) for status in statuses})[:20],
            "githubClass": github_class, "precommitFailed": bool(re.search(r"pre-commit[^\n]*failed", text, re.I))}


def api(path):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "aman-t3-managed-publisher"}
    # Only GitHub's API receives the ephemeral workflow token, never an asset origin.
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    request = Request("https://api.github.com/" + path, headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def config_at(path):
    config = read_json(path)
    require(config.get("schemaVersion") == 1, "unsupported publisher config")
    require(config.get("distribution") == DISTRIBUTION, "unexpected distribution")
    require(config.get("upstreamRepository") == UPSTREAM, "unexpected upstream")
    require(config.get("releaseRepository") == REPOSITORY, "unexpected release repository")
    require(SHA.fullmatch(config.get("patchBaseCommit", "")), "invalid patch base")
    require(re.fullmatch(r"[A-Za-z0-9_./-]+", config.get("patchRef", "")), "invalid patch ref")
    version_key(config["minimumVersion"])
    return config


def select_version(releases, existing, minimum, requested=None):
    candidates = []
    for release in releases:
        if release.get("draft") or not release.get("published_at"):
            continue
        version = release.get("tag_name", "").removeprefix("v")
        if NIGHTLY.fullmatch(version) and version_key(version) >= version_key(minimum):
            candidates.append(version)
    if requested:
        version_key(requested)
        require(requested in candidates, "requested version is not a published upstream nightly")
        candidates = [requested]
    for version in sorted(set(candidates), key=version_key):
        release = existing(version)
        if release is None:
            return version
        require(not release.get("draft"), "an existing draft requires operator review; no overwrite")
        require(release.get("immutable") is True, "existing managed release is not immutable")
        names = {asset["name"] for asset in release.get("assets", [])}
        source_archives = {name for name in names if re.fullmatch(
            r"t3-managed-source-" + re.escape(version) + r"-[a-f0-9]{12}\.tar\.gz", name)}
        require(len(names) == 6 and len(source_archives) == 1
                and {"managed-build.json", "provenance.json", "SHA256SUMS", "source-commit.txt",
                     f"t3-{version}-linux-x64.tar.gz"} <= names,
                "existing release is not a complete managed release; no overwrite")
        require(release.get("name") == f"Aman managed T3 {version} (Linux x64)",
                "existing release has another publisher identity; no overwrite")
    return None


def list_releases(repository):
    releases = []
    for page in range(1, 101):
        batch = api(f"repos/{repository}/releases?per_page=100&page={page}")
        require(isinstance(batch, list), "cannot list releases")
        releases.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError("release listing exceeded bounded pagination; review required")
    return releases


def select(config, output, requested=None):
    # One paginated index per repository, rather than one API request per historical nightly.
    # Immutable completed releases were fully verified when published and cannot be edited.
    releases = list_releases(UPSTREAM)
    managed = {r["tag_name"].removeprefix("v"): r for r in list_releases(REPOSITORY)}
    version = select_version(releases, managed.get,
                             config["minimumVersion"], requested)
    selection = {"version": version}
    if version:
        # Resolve the maintained branch ONCE; later preparation uses only this immutable SHA.
        commit = api(f"repos/{REPOSITORY}/commits/{config['patchRef']}")
        require(isinstance(commit, dict) and SHA.fullmatch(commit.get("sha", "")),
                "maintained patch branch is not available")
        selection["patchSourceCommit"] = commit["sha"]
    write_json(output, selection)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"version={version or ''}\n")


def prepare(config, selection, directory, context_path):
    version = selection["version"]
    version_key(version)
    patch_head = selection["patchSourceCommit"]
    require(SHA.fullmatch(patch_head), "invalid patch source commit")
    directory = Path(directory).resolve()
    require(not directory.exists(), "prepared source directory must not exist")
    # Complete commit ancestry is retained so the prepared source can be published as a tag.
    run("git", "clone", "--filter=blob:none", "--no-checkout", "--no-tags",
        f"https://github.com/{UPSTREAM}.git", str(directory))
    git(directory, "fetch", "--no-tags", "origin", f"refs/tags/v{version}")
    upstream = git(directory, "rev-parse", "FETCH_HEAD^{commit}")
    require(SHA.fullmatch(upstream), "upstream tag did not resolve to a commit")
    git(directory, "fetch", "--no-tags", f"https://github.com/{REPOSITORY}.git", patch_head)
    apply_maintained_patch(directory, config["patchBaseCommit"], patch_head, upstream)
    context = {"schemaVersion": 1, "distribution": DISTRIBUTION, "upstreamVersion": version,
               "upstreamSourceCommit": upstream, "patchBaseCommit": config["patchBaseCommit"],
               "patchSourceCommit": patch_head, "sourceDateEpoch": git(directory, "show", "-s", "--format=%ct", upstream),
               "publisherCommit": git(Path(__file__).resolve().parents[2], "rev-parse", "HEAD")}
    write_json(context_path, context)


def apply_maintained_patch(directory, base, head, upstream):
    git(directory, "merge-base", "--is-ancestor", base, head)
    patch = run("git", "diff", "--binary", "--full-index", base, head, cwd=directory)
    require(patch.strip(), "maintained patch is empty")
    git(directory, "checkout", "--detach", upstream)
    # No three-way merge, fuzz, fallback, or best-effort application.
    run("git", "apply", "--check", "--index", "-", cwd=directory, input=patch)
    run("git", "apply", "--index", "-", cwd=directory, input=patch)


def seal_source(directory, context_path):
    context = read_json(context_path)
    version = context["upstreamVersion"]
    # The normal upstream version-alignment script must have run before sealing.
    for relative in ("apps/server/package.json", "apps/desktop/package.json",
                     "apps/web/package.json", "packages/contracts/package.json"):
        require(read_json(Path(directory) / relative)["version"] == version,
                f"release version was not aligned in {relative}")
    # .env contains public build inputs but is never committed; only tracked source changes enter.
    git(directory, "add", "--update")
    env = dict(os.environ, GIT_AUTHOR_NAME="Aman managed T3", GIT_AUTHOR_EMAIL="managed-build@users.noreply.github.com",
               GIT_COMMITTER_NAME="Aman managed T3", GIT_COMMITTER_EMAIL="managed-build@users.noreply.github.com",
               GIT_AUTHOR_DATE=f"{context['sourceDateEpoch']} +0000", GIT_COMMITTER_DATE=f"{context['sourceDateEpoch']} +0000")
    git(directory, "commit", "--no-gpg-sign", "-m", f"Aman managed {version}\n\nPatch source: {context['patchSourceCommit']}", env=env)
    context["sourceCommit"] = git(directory, "rev-parse", "HEAD")
    context["buildId"] = f"{version}-{context['sourceCommit'][:12]}"
    write_json(context_path, context)
    return build_manifest(context)


def build_manifest(context):
    return {key: context[key] for key in ("schemaVersion", "distribution", "buildId", "upstreamVersion",
                                          "upstreamSourceCommit", "sourceCommit")}


def archive_manifest(archive, version):
    stem = f"t3-{version}-linux-x64"
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        names = set()
        links = {member.name: member.linkname for member in members if member.issym()}
        def resolve_path(parts):
            pending, resolved, expansions = list(parts), [], 0
            while pending:
                part = pending.pop(0)
                if part == ".":
                    continue
                if part == "..":
                    require(len(resolved) > 1, "archive link escapes its root")
                    resolved.pop()
                    continue
                resolved.append(part)
                require(resolved[0] == stem, "archive link escapes its root")
                if "/".join(resolved) in links:
                    target = PurePosixPath(links["/".join(resolved)])
                    require(not target.is_absolute(), "archive contains absolute link")
                    resolved.pop()
                    expansions += 1
                    require(expansions <= 40, "archive contains cyclic or excessive links")
                    pending = list(target.parts) + pending
            require(resolved and resolved[0] == stem, "archive link escapes its root")
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts and path.parts[0] == stem,
                    "archive entry escapes its versioned root")
            require(member.name not in names, "duplicate archive member")
            names.add(member.name)
            require(not member.isdev() and not member.isfifo(), "archive contains special files")
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                require(not target.is_absolute(), "archive contains absolute link")
                resolve_path(list(path.parent.parts if member.issym() else ()) + list(target.parts))
            if len(path.parts) > 1:
                resolve_path(path.parent.parts)
        entry = tar.getmember(f"{stem}/t3")
        require(entry.isfile() and entry.mode & 0o111, "archive has no executable t3")
        require(f"{stem}/client/index.html" in names and any(n.startswith(f"{stem}/resource-monitor/") for n in names),
                "archive lacks the native client or resource monitor")
        manifest = tar.getmember(f"{stem}/managed-build.json")
        require(manifest.isfile() and manifest.size <= 16384, "invalid managed build manifest")
        package = tar.getmember(f"{stem}/package.json")
        require(package.isfile() and package.size <= 1024 * 1024, "invalid runtime package manifest")
        metadata = json.load(tar.extractfile(package))
        require(isinstance(metadata, dict) and metadata.get("version") == version and type(metadata.get("serviceOwnershipProtocol")) is int
                and metadata["serviceOwnershipProtocol"] == 1, "runtime package lacks the required ownership capability")
        build = json.load(tar.extractfile(manifest))
        require(isinstance(build, dict) and type(build.get("schemaVersion")) is int and build["schemaVersion"] == 1
                and build.get("distribution") == DISTRIBUTION and build.get("upstreamVersion") == version
                and isinstance(build.get("buildId"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]*", build["buildId"])
                and all(isinstance(build.get(key), str) and SHA.fullmatch(build[key])
                        for key in ("sourceCommit", "upstreamSourceCommit")), "invalid managed build identity")
        return build


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def package(context_path, archive, output, source):
    context = read_json(context_path)
    expected = build_manifest(context)
    require(archive_manifest(archive, context["upstreamVersion"]) == expected,
            "archive provenance differs from the sealed build source")
    output = Path(output)
    require(not output.exists(), "release output must not exist")
    output.mkdir(parents=True)
    filename = f"t3-{context['upstreamVersion']}-linux-x64.tar.gz"
    shutil.copyfile(archive, output / filename)
    write_json(output / "managed-build.json", expected)
    require(git(source, "rev-parse", "HEAD") == context["sourceCommit"], "source differs from sealed commit")
    require(not git(source, "status", "--porcelain", "--untracked-files=no"), "tracked source changed after sealing")
    source_name = f"t3-managed-source-{context['buildId']}.tar.gz"
    # Full source is a release ASSET. GITHUB_TOKEN cannot publish commits with changed workflows.
    raw_source = run("git", "archive", "--format=tar", "HEAD", cwd=source)
    with open(output / source_name, "wb") as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as compressed:
            compressed.write(raw_source)
    (output / "source-commit.txt").write_bytes(run("git", "cat-file", "commit", "HEAD", cwd=source))
    provenance = dict(context, platform="linux-x64", officialArtifact=False,
                      archiveSha256=digest(output / filename),
                      sourceArchive=source_name, sourceArchiveSha256=digest(output / source_name),
                      buildUrl=os.environ.get("GITHUB_SERVER_URL", "https://github.com") + "/" + REPOSITORY + "/actions/runs/" + os.environ.get("GITHUB_RUN_ID", "local"))
    write_json(output / "provenance.json", provenance)
    (output / "SHA256SUMS").write_text("".join(f"{digest(output / name)}  {name}\n" for name in
                                              asset_names(provenance)))
    verify_package(output)


def asset_names(provenance):
    return (f"t3-{provenance['upstreamVersion']}-linux-x64.tar.gz", "managed-build.json", "provenance.json",
            f"t3-managed-source-{provenance['buildId']}.tar.gz", "source-commit.txt")


def verify_package(directory):
    directory = Path(directory)
    provenance = read_json(directory / "provenance.json")
    version_key(provenance["upstreamVersion"])
    require(provenance["distribution"] == DISTRIBUTION and provenance["officialArtifact"] is False,
            "not an identified managed artifact")
    for key in ("sourceCommit", "upstreamSourceCommit", "patchSourceCommit", "patchBaseCommit", "publisherCommit"):
        require(SHA.fullmatch(provenance[key]), "invalid source identity")
    require(provenance["platform"] == "linux-x64", "unsupported runtime platform")
    require(provenance["buildId"] == f"{provenance['upstreamVersion']}-{provenance['sourceCommit'][:12]}",
            "build ID differs from source identity")
    expected = build_manifest(provenance)
    filename = f"t3-{provenance['upstreamVersion']}-linux-x64.tar.gz"
    require(read_json(directory / "managed-build.json") == expected, "release manifest mismatch")
    require(archive_manifest(directory / filename, provenance["upstreamVersion"]) == expected,
            "archive manifest mismatch")
    require(digest(directory / filename) == provenance["archiveSha256"], "archive digest mismatch")
    source_name = f"t3-managed-source-{provenance['buildId']}.tar.gz"
    require(provenance["sourceArchive"] == source_name and digest(directory / source_name) == provenance["sourceArchiveSha256"],
            "source archive digest mismatch")
    commit = (directory / "source-commit.txt").read_bytes()
    require(len(commit) <= 65536 and hashlib.sha1(f"commit {len(commit)}\0".encode() + commit).hexdigest() == provenance["sourceCommit"],
            "source commit object mismatch")
    with tarfile.open(directory / source_name, "r:gz") as tar:
        require(tar.pax_headers.get("comment") == provenance["sourceCommit"], "source archive commit differs")
    expected_sums = "".join(f"{digest(directory / name)}  {name}\n" for name in
                            asset_names(provenance))
    require((directory / "SHA256SUMS").read_text() == expected_sums, "release checksums mismatch")
    require({p.name for p in directory.iterdir()} == set(asset_names(provenance)) | {"SHA256SUMS"},
            "unexpected release asset")
    return provenance


def publish(directory, source):
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "publishing is restricted to the public managed fork")
    provenance = verify_package(directory)
    version = provenance["upstreamVersion"]
    # The setting's GET requires Administration(read), which GITHUB_TOKEN cannot receive.
    # Setup verifies it with the operator's existing admin access, then sets this nonsecret
    # Actions variable. Actual acceptance below still requires immutable=true + attestations.
    require(os.environ.get("AMAN_MANAGED_IMMUTABILITY_VERIFIED") == "true",
            "operator must verify repository immutable releases and record the setup prerequisite")
    require(api(f"repos/{REPOSITORY}/releases/tags/v{version}") is None,
            "release already exists; no replacement or overwrite")
    require(git(source, "rev-parse", "HEAD") == provenance["sourceCommit"], "source HEAD differs from archive")
    require(not git(source, "status", "--porcelain", "--untracked-files=no"), "build changed tracked source after sealing")
    publisher = provenance["publisherCommit"]
    require(os.environ.get("GITHUB_SHA") == publisher, "publisher commit differs from workflow source")
    current_main = api(f"repos/{REPOSITORY}/commits/main")
    require(isinstance(current_main, dict) and current_main.get("sha") == publisher,
            "publisher main advanced during the build; rerun before publication")
    require(api(f"repos/{REPOSITORY}/git/ref/tags/v{version}") is None,
            "canonical tag already exists; never repoint or publish over an upstream tag")
    # Fail before creating a draft when the runner's gh predates release attestation support.
    run("gh", "release", "verify", "--help")
    run("gh", "release", "verify-asset", "--help")
    notes = (f"Aman-managed Linux x64 runtime; NOT an official T3 artifact.\n\n"
             f"Upstream compatibility version: {version}\n"
             f"Upstream source: {provenance['upstreamSourceCommit']}\n"
             f"Built source: {provenance['sourceCommit']}\n"
             f"Full exact build source: attached {provenance['sourceArchive']}\n"
             f"Release tag points to publisher commit {publisher}; it does NOT claim to be an upstream source tag.\n"
             f"Build ID: {provenance['buildId']}\n\n"
             "Only the listed Linux x64 runtime is supported. Other architectures and desktop builds are not published.\n"
             "Managed source provenance and archive checksums are attached. This release never mirrors unpatched official runtime bytes.\n")
    notes_path = Path(directory).parent / "managed-release-notes.md"
    notes_path.write_text(notes)
    run("gh", "release", "create", f"v{version}", "--repo", REPOSITORY, "--target", publisher, "--draft", "--prerelease",
        "--title", f"Aman managed T3 {version} (Linux x64)", "--notes-file", str(notes_path),
        *[str(path) for path in sorted(Path(directory).iterdir())])
    # A partial upload remains a draft requiring review. Never --clobber, delete, or overwrite.
    remote_release = json.loads(run("gh", "api", f"repos/{REPOSITORY}/releases/tags/v{version}"))
    require({a["name"] for a in remote_release["assets"]} == {p.name for p in Path(directory).iterdir()},
            "draft upload is incomplete")
    for asset in remote_release["assets"]:
        local = Path(directory) / asset["name"]
        require(asset["size"] == local.stat().st_size and asset.get("digest") == "sha256:" + digest(local),
                "uploaded asset digest differs; draft requires review")
    tag = api(f"repos/{REPOSITORY}/git/ref/tags/v{version}")
    require(isinstance(tag, dict) and tag.get("object", {}).get("type") == "commit"
            and tag["object"].get("sha") == publisher,
            "canonical tag changed during draft creation; leave draft for review")
    run("gh", "release", "edit", f"v{version}", "--repo", REPOSITORY, "--draft=false")
    published = json.loads(run("gh", "api", f"repos/{REPOSITORY}/releases/tags/v{version}"))
    if published.get("immutable") is not True or published.get("draft"):
        if not published.get("draft"):
            try:
                run("gh", "release", "edit", f"v{version}", "--repo", REPOSITORY, "--draft=true")
            except subprocess.CalledProcessError as error:
                raise ValueError("release is mutable and retraction failed; operator must retract it") from error
        raise ValueError("release did not become immutable; retracted to draft for operator review")
    run("gh", "release", "verify", f"v{version}", "--repo", REPOSITORY)
    for asset in sorted(Path(directory).iterdir()):
        run("gh", "release", "verify-asset", f"v{version}", str(asset), "--repo", REPOSITORY)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(Path(__file__).with_name("config.json")))
    commands = parser.add_subparsers(dest="command", required=True)
    sub = commands.add_parser("select")
    sub.add_argument("--output", required=True)
    sub.add_argument("--version")
    sub = commands.add_parser("prepare")
    sub.add_argument("--selection", required=True)
    sub.add_argument("--source", required=True)
    sub.add_argument("--context", required=True)
    sub = commands.add_parser("seal")
    sub.add_argument("--source", required=True)
    sub.add_argument("--context", required=True)
    sub = commands.add_parser("package")
    sub.add_argument("--context", required=True)
    sub.add_argument("--archive", required=True)
    sub.add_argument("--output", required=True)
    sub.add_argument("--source", required=True)
    sub = commands.add_parser("verify")
    sub.add_argument("--directory", required=True)
    sub = commands.add_parser("publish")
    sub.add_argument("--directory", required=True)
    sub.add_argument("--source", required=True)
    args = parser.parse_args()
    config = config_at(args.config)
    if args.command == "select":
        select(config, args.output, args.version)
    elif args.command == "prepare":
        prepare(config, read_json(args.selection), args.source, args.context)
    elif args.command == "seal":
        print(json.dumps(seal_source(args.source, args.context), separators=(",", ":")))
    elif args.command == "package":
        package(args.context, args.archive, args.output, args.source)
    elif args.command == "verify":
        verify_package(args.directory)
    elif args.command == "publish":
        publish(args.directory, args.source)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        # Do not dump subprocess output, commands, or inherited environment on failure.
        print(f"Managed publisher stopped: {type(error).__name__}: " +
              (json.dumps(subprocess_diagnostic(error)) if isinstance(error, subprocess.CalledProcessError) else str(error)), file=sys.stderr)
        sys.exit(1)
