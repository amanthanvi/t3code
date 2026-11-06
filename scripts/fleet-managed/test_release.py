import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("managed_release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
VERSION = "0.1.8-nightly.20261106.4247"
NEWER = "0.1.8-nightly.20261106.4250"


def context():
    source = "b" * 40
    build_id = f"{VERSION}-{source[:12]}"
    return {"schemaVersion": 1, "distribution": release.DISTRIBUTION, "buildId": build_id,
            "upstreamVersion": VERSION, "upstreamSourceCommit": "a" * 40, "sourceCommit": source,
            "patchSourceCommit": "c" * 40, "patchBaseCommit": "d" * 40,
            "sourceDateEpoch": "1793923200", "publisherCommit": "e" * 40}


def archive(path, manifest=None, extras=(), omit=()):
    stem = f"t3-{VERSION}-linux-x64"
    contents = {"t3": b"test executable", "client/index.html": b"client",
                "resource-monitor/linux-x64/t3-resource-monitor": b"native monitor",
                "package.json": json.dumps({"version": VERSION, "serviceOwnershipProtocol": 1}).encode(),
                "managed-build.json": json.dumps(manifest or release.build_manifest(context())).encode()}
    with tarfile.open(path, "w:gz") as tar:
        root = tarfile.TarInfo(stem)
        root.type = tarfile.DIRTYPE
        tar.addfile(root)
        for name, data in contents.items():
            if name in omit:
                continue
            member = tarfile.TarInfo(f"{stem}/{name}")
            member.mode = 0o755 if name == "t3" else 0o644
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
        for member in extras:
            tar.addfile(member, io.BytesIO(b""))


class SelectionTests(unittest.TestCase):
    def releases(self):
        return [{"tag_name": "v" + version, "published_at": "2026-11-06"}
                for version in (NEWER, VERSION)]

    def test_oldest_missing_release_is_not_latest_only(self):
        self.assertEqual(release.select_version(self.releases(), lambda v: None, VERSION), VERSION)

    def test_draft_and_stable_upstream_are_never_built(self):
        releases = self.releases() + [{"tag_name": "v0.1.9", "published_at": "today"},
                                     {"tag_name": "v0.1.8-nightly.20261106.4248", "draft": True}]
        self.assertEqual(release.select_version(releases, lambda v: None, NEWER), NEWER)

    def test_nonpublished_requested_version_is_refused(self):
        with self.assertRaisesRegex(ValueError, "not a published"):
            release.select_version(self.releases(), lambda v: None, VERSION, "0.1.8-nightly.20261106.9999")

    def test_incomplete_or_foreign_release_is_not_overwritten_or_skipped(self):
        for existing in ({"draft": True}, {"draft": False, "assets": []}):
            with self.subTest(existing=existing), self.assertRaises(ValueError):
                release.select_version(self.releases(), lambda v: existing, VERSION)

    def test_completed_release_drains_backlog(self):
        names = ("managed-build.json", "provenance.json", "SHA256SUMS", f"t3-{VERSION}-linux-x64.tar.gz",
                 "source-commit.txt", f"t3-managed-source-{VERSION}-{'b' * 12}.tar.gz")
        existing = {"name": f"Aman managed T3 {VERSION} (Linux x64)",
                    "immutable": True,
                    "assets": [{"name": n} for n in names]}
        self.assertEqual(release.select_version(self.releases(), lambda v: existing if v == VERSION else None, VERSION), NEWER)

    def test_missing_source_assets_are_not_treated_as_completed_releases(self):
        names = ("managed-build.json", "provenance.json", "SHA256SUMS", f"t3-{VERSION}-linux-x64.tar.gz",
                 "source-commit.txt", f"t3-managed-source-{VERSION}-{'b' * 12}.tar.gz")
        for missing in names[-2:]:
            existing = {"name": f"Aman managed T3 {VERSION} (Linux x64)", "immutable": True,
                        "assets": [{"name": n} for n in names if n != missing]}
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "not a complete"):
                release.select_version(self.releases(), lambda v: existing, VERSION)

    def test_version_input_cannot_be_shell_or_path_syntax(self):
        for value in ("../x", VERSION + "+aman.1", VERSION + ";true", VERSION + ".aman.1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.version_key(value)


class DiagnosticTests(unittest.TestCase):
    def test_reports_only_fixed_operation_status_and_github_error_classes(self):
        secret = "ghp_SENTINEL_AUTH_TOKEN_DO_NOT_EMIT"
        for command, stderr, expected, status, help_flag in (
            (["gh", "release", "create", secret], f"HTTP 403: Resource not accessible by integration Authorization: Bearer {secret}", "permission_denied", [403], False),
            (["gh", "release", "edit", secret], f"HTTP 404: Not Found\nTOKEN={secret}", "not_found", [404], False),
            (["gh", "release", "verify", "--help"], f"unknown command verify {secret}", "unsupported_command", [], True),
            (["gh", "release", "verify-asset", secret], "HTTP 422: Validation Failed", "validation_failed", [422], False),
            (["gh", "api", secret], "HTTP 409: Conflict", "conflict", [409], False),
        ):
            with self.subTest(command=command[:3]):
                error = subprocess.CalledProcessError(1, command, stderr=stderr)
                report = release.subprocess_diagnostic(error)
                self.assertEqual(report["operation"], ".".join(command[:3] if command[1] == "release" else command[:2]))
                self.assertEqual((report["githubClass"], report["httpStatuses"], report["help"]), (expected, status, help_flag))
                self.assertEqual(set(report), {"operation", "help", "exitCode", "ruleCodes", "httpStatuses", "githubClass", "precommitFailed"})
                for value in (secret, "Authorization", "Bearer", "TOKEN=", "accessible", "Not Found"):
                    self.assertNotIn(value, json.dumps(report))

    def test_unknown_commands_and_arguments_cannot_become_diagnostic_labels(self):
        secret = "github_pat_SENTINEL_DO_NOT_EMIT"
        for command in (["/tmp/" + secret, "publish"], ["gh", secret, "create"], "gh " + secret):
            with self.subTest(command=type(command).__name__):
                report = release.subprocess_diagnostic(subprocess.CalledProcessError(2, command,
                            output=b"unrecognized diagnostic \xff", stderr="unknown arbitrary text"))
                self.assertNotIn(secret, json.dumps(report))
                self.assertEqual(report["operation"], "gh" if isinstance(command, list) and command[0] == "gh" else "subprocess")
                self.assertIsNone(report["githubClass"])

    def test_git_stage_and_bounded_rule_codes_survive_without_source_or_streams(self):
        codes = " ".join(f"TS{number}" for number in range(1000, 1040))
        report = release.subprocess_diagnostic(subprocess.CalledProcessError(3, ["/usr/bin/git", "rev-parse", "SECRET_ARGUMENT"],
                    output=f"{codes}\nSOURCE_BODY_SENTINEL\n", stderr=b"unicorn(no-useless-spread)\nVITE+ - pre-commit script failed (code 1)"))
        self.assertEqual((report["operation"], report["exitCode"], report["help"]), ("git.rev-parse", 3, False))
        self.assertEqual(len(report["ruleCodes"]), 20)
        self.assertTrue(report["precommitFailed"])
        self.assertNotIn("SENTINEL", json.dumps(report))

    def test_publisher_cli_emits_safe_diagnostic_instead_of_captured_streams(self):
        secret = "github_pat_SENTINEL_NEVER_PRINT"
        failure = subprocess.CalledProcessError(1, ["gh", "release", "create", secret],
                    output=f"SOURCE_BODY {secret}".encode(), stderr=f"HTTP 403: Resource not accessible by integration\nBearer {secret}")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selection = root / "selection.json"
            release.write_json(selection, {"version": VERSION, "patchSourceCommit": "c" * 40})
            argv = [release.__file__, "prepare", "--selection", str(selection), "--source", str(root / "source"), "--context", str(root / "context.json")]
            errors = io.StringIO()
            with patch("sys.argv", argv), patch("sys.stderr", errors), patch("subprocess.run", side_effect=failure), \
                    self.assertRaises(SystemExit) as stopped:
                runpy.run_path(release.__file__, run_name="__main__")
            self.assertEqual(stopped.exception.code, 1)
            emitted = errors.getvalue()
            self.assertNotIn(secret, emitted)
            self.assertNotIn("SOURCE_BODY", emitted)
            report = json.loads(emitted.split("CalledProcessError: ", 1)[1])
            self.assertEqual((report["operation"], report["httpStatuses"], report["githubClass"]),
                             ("gh.release.create", [403], "permission_denied"))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tar = self.root / "runtime.tar.gz"
        self.source = self.root / "source"
        self.source.mkdir()
        release.git(self.source, "init", "-b", "main")
        release.git(self.source, "config", "user.name", "Test")
        release.git(self.source, "config", "user.email", "test@example.invalid")
        (self.source / "server.txt").write_text("source fixture\n")
        release.git(self.source, "add", "--all")
        release.git(self.source, "commit", "-m", "source fixture")
        self.context = context()
        self.context["sourceCommit"] = release.git(self.source, "rev-parse", "HEAD")
        self.context["buildId"] = f"{VERSION}-{self.context['sourceCommit'][:12]}"

    def test_complete_managed_archive_is_accepted(self):
        archive(self.tar)
        self.assertEqual(release.archive_manifest(self.tar, VERSION), release.build_manifest(context()))

    def test_required_native_components_cannot_be_omitted(self):
        for missing in ("t3", "client/index.html", "resource-monitor/linux-x64/t3-resource-monitor", "managed-build.json", "package.json"):
            archive(self.tar, omit=(missing,))
            with self.subTest(missing=missing), self.assertRaises((ValueError, KeyError)):
                release.archive_manifest(self.tar, VERSION)

    def test_unsafe_archive_members_are_refused(self):
        for name in ("../outside", "/absolute", f"t3-{VERSION}-linux-x64/../../outside"):
            member = tarfile.TarInfo(name)
            archive(self.tar, extras=(member,))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "escapes"):
                release.archive_manifest(self.tar, VERSION)

    def test_escaping_links_are_refused_but_internal_node_links_work(self):
        stem = f"t3-{VERSION}-linux-x64"
        for target in ("/etc/passwd", "../../outside"):
            member = tarfile.TarInfo(stem + "/node_modules/link")
            member.type = tarfile.SYMTYPE
            member.linkname = target
            archive(self.tar, extras=(member,))
            with self.subTest(target=target), self.assertRaises(ValueError):
                release.archive_manifest(self.tar, VERSION)
        member.linkname = "../package"
        archive(self.tar, extras=(member,))
        release.archive_manifest(self.tar, VERSION)

    def test_chained_symlink_cannot_escape_after_parent_traversal(self):
        stem = f"t3-{VERSION}-linux-x64"
        alias = tarfile.TarInfo(stem + "/a")
        alias.type, alias.linkname = tarfile.SYMTYPE, "."
        directory = tarfile.TarInfo(stem + "/b")
        directory.type = tarfile.DIRTYPE
        escape = tarfile.TarInfo(stem + "/escape")
        escape.type, escape.linkname = tarfile.SYMTYPE, "a/b/../.."
        archive(self.tar, extras=(alias, directory, escape))
        with self.assertRaisesRegex(ValueError, "escapes"):
            release.archive_manifest(self.tar, VERSION)

    def test_capability_and_canonical_package_version_are_required(self):
        for package in ({"version": VERSION}, {"version": NEWER, "serviceOwnershipProtocol": 1},
                        {"version": VERSION, "serviceOwnershipProtocol": True}):
            archive(self.tar, omit=("package.json",))
            # Rebuild fixture with an invalid package as the only root package member.
            with tarfile.open(self.tar, "r:gz") as old:
                members = [(member, old.extractfile(member).read() if member.isfile() else None) for member in old.getmembers()]
            with tarfile.open(self.tar, "w:gz") as tar:
                for member, data in members:
                    tar.addfile(member, io.BytesIO(data) if data is not None else None)
                data = json.dumps(package).encode()
                member = tarfile.TarInfo(f"t3-{VERSION}-linux-x64/package.json")
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
            with self.subTest(package=package), self.assertRaisesRegex(ValueError, "ownership capability"):
                release.archive_manifest(self.tar, VERSION)

    def make_package(self):
        archive(self.tar, release.build_manifest(self.context))
        path = self.root / "context.json"
        release.write_json(path, self.context)
        output = self.root / "release"
        release.package(path, self.tar, output, self.source)
        return output

    def test_packaged_bytes_and_source_are_bound_and_no_repackage_in_place(self):
        output = self.make_package()
        self.assertEqual(release.verify_package(output)["sourceCommit"], self.context["sourceCommit"])
        with self.assertRaisesRegex(ValueError, "must not exist"):
            release.package(self.root / "context.json", self.tar, output, self.source)
        (output / "managed-build.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            release.verify_package(output)

    def test_mismatched_archive_build_is_refused(self):
        manifest = release.build_manifest(context())
        manifest["sourceCommit"] = "e" * 40
        archive(self.tar, manifest)
        release.write_json(self.root / "context.json", context())
        with self.assertRaisesRegex(ValueError, "differs"):
            release.package(self.root / "context.json", self.tar, self.root / "release", self.source)

    def test_boolean_build_schema_does_not_compare_equal_to_integer_one(self):
        manifest = release.build_manifest(context())
        manifest["schemaVersion"] = True
        archive(self.tar, manifest)
        with self.assertRaisesRegex(ValueError, "managed build identity"):
            release.archive_manifest(self.tar, VERSION)

    def test_publish_refuses_existing_release_before_any_mutation(self):
        output = self.make_package()
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "list_releases", return_value=[{"tag_name": "v" + VERSION, "draft": True}]), \
                patch.object(release, "run") as run:
            with self.assertRaisesRegex(ValueError, "already exists"):
                release.publish(output, self.root)
            run.assert_not_called()

    def test_publish_requires_operator_verified_immutability_setup(self):
        output = self.make_package()
        for value in ("", "false"):
            with self.subTest(value=value), \
                    patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": value}), \
                    patch.object(release, "api") as api, \
                    patch.object(release, "run") as run:
                with self.assertRaisesRegex(ValueError, "operator must verify"):
                    release.publish(output, self.source)
                api.assert_not_called()
                run.assert_not_called()

    def test_publish_never_repoints_existing_canonical_tag(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "list_releases", return_value=[]), \
                patch.object(release, "api", side_effect=[{"sha": publisher}, {"ref": "already exists"}]), \
                patch.object(release, "run", wraps=release.run) as run:
            with self.assertRaisesRegex(ValueError, "canonical tag already exists"):
                release.publish(output, self.source)
            self.assertTrue(all(call.args[0] == "git" for call in run.call_args_list))

    def test_publish_checks_uploaded_digests_and_result_is_immutable(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + release.digest(p)}
                  for p in output.iterdir()]
        draft = {"id": 42, "tag_name": "v" + VERSION, "name": f"Aman managed T3 {VERSION} (Linux x64)",
                 "target_commitish": publisher, "draft": True, "assets": assets}
        actual_run = release.run
        state = {"created": False, "published": False}
        def fake_api(endpoint):
            if endpoint.endswith("/commits/main"):
                return {"sha": publisher}
            if "/git/ref/tags/" in endpoint:
                return {"object": {"type": "commit", "sha": publisher}} if state["published"] else None
            if endpoint.endswith("/releases/42"):
                return dict(draft, draft=not state["published"], immutable=state["published"])
            if "/releases/tags/" in endpoint:
                return None
            self.fail("unexpected release API read")
        def fake_run(*args, **kwargs):
            if args[0] == "git":
                return actual_run(*args, **kwargs)
            if args[:3] == ("gh", "release", "create"):
                state["created"] = True
            if args[:2] == ("gh", "api"):
                if args[2:5] == ("--method", "PATCH", f"repos/{release.REPOSITORY}/releases/42"):
                    state["published"] = "draft=false" in args
                else:
                    # GitHub's tag route exposes published releases, not newly created drafts.
                    raise subprocess.CalledProcessError(1, args, stderr=b"HTTP 404: Not Found")
            return b""
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "api", side_effect=fake_api), \
                patch.object(release, "list_releases", side_effect=lambda _: [draft] if state["created"] else []), \
                patch.object(release, "run", side_effect=fake_run) as run:
            release.publish(output, self.source)
            commands = [call.args[:3] for call in run.call_args_list if call.args[0] == "gh"]
            self.assertIn(("gh", "release", "create"), commands)
            self.assertTrue(state["published"])
            self.assertIn(("gh", "api", "--method"), commands)
            self.assertIn(("gh", "release", "verify"), commands)
            self.assertEqual(sum(call.args[:3] == ("gh", "release", "verify-asset") and "--help" not in call.args
                                 for call in run.call_args_list), len(assets))

    def test_tag_created_by_another_actor_during_draft_is_not_published(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + release.digest(p)}
                  for p in output.iterdir()]
        draft = {"id": 42, "tag_name": "v" + VERSION, "name": f"Aman managed T3 {VERSION} (Linux x64)",
                 "target_commitish": publisher, "draft": True, "assets": assets}
        actual_run = release.run
        def fake_run(*args, **kwargs):
            if args[0] == "git":
                return actual_run(*args, **kwargs)
            if args[:2] == ("gh", "api"):
                return json.dumps({"assets": assets}).encode()
            return b""
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "list_releases", side_effect=[[], [draft]]), \
                patch.object(release, "api", side_effect=[{"sha": publisher}, None, draft, {"sha": publisher},
                                                        {"object": {"type": "commit", "sha": "f" * 40}}]), \
                patch.object(release, "run", side_effect=fake_run) as run:
            with self.assertRaisesRegex(ValueError, "changed during draft"):
                release.publish(output, self.source)
            self.assertFalse(any(call.args[:3] == ("gh", "api", "--method") for call in run.call_args_list))

    def test_mutable_publication_is_immediately_retracted_and_never_attested(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + release.digest(p)}
                  for p in output.iterdir()]
        draft = {"id": 42, "tag_name": "v" + VERSION, "name": f"Aman managed T3 {VERSION} (Linux x64)",
                 "target_commitish": publisher, "draft": True, "assets": assets}
        actual_run = release.run
        def fake_run(*args, **kwargs):
            if args[0] == "git":
                return actual_run(*args, **kwargs)
            if args[:2] == ("gh", "api"):
                return json.dumps({"assets": assets, "immutable": False, "draft": False}).encode()
            return b""
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "list_releases", side_effect=[[], [draft]]), \
                patch.object(release, "api", side_effect=[{"sha": publisher}, None, draft, {"sha": publisher}, None,
                                                        dict(draft, draft=False, immutable=False),
                                                        {"object": {"type": "commit", "sha": publisher}}]), \
                patch.object(release, "run", side_effect=fake_run) as run:
            with self.assertRaisesRegex(ValueError, "retracted to draft"):
                release.publish(output, self.source)
            edits = [call.args for call in run.call_args_list if call.args[:3] == ("gh", "api", "--method")]
            self.assertEqual(edits[-1][-1], "draft=true")
            self.assertFalse(any(call.args[:3] == ("gh", "release", "verify") and "--help" not in call.args
                                 for call in run.call_args_list))

    def test_wrong_draft_identity_or_asset_digest_never_reaches_publication(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + release.digest(p)}
                  for p in output.iterdir()]
        draft = {"id": 42, "tag_name": "v" + VERSION, "name": f"Aman managed T3 {VERSION} (Linux x64)",
                 "target_commitish": publisher, "draft": True, "assets": assets}
        actual_run = release.run
        def fake_run(*args, **kwargs):
            return actual_run(*args, **kwargs) if args[0] == "git" else b""
        for changes, message in (({"target_commitish": "f" * 40}, "draft identity differs"),
                                 ({"draft": False}, "draft identity differs"),
                                 ({"assets": []}, "draft upload is incomplete"),
                                 ({"assets": [dict(assets[0], digest="sha256:" + "0" * 64), *assets[1:]]}, "asset digest differs")):
            with self.subTest(changes=list(changes)), \
                    patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                    patch.object(release, "list_releases", side_effect=[[], [draft]]), \
                    patch.object(release, "api", side_effect=[{"sha": publisher}, None, dict(draft, **changes)]), \
                    patch.object(release, "run", side_effect=fake_run) as run:
                with self.assertRaisesRegex(ValueError, message):
                    release.publish(output, self.source)
                self.assertFalse(any(call.args[:3] == ("gh", "api", "--method") for call in run.call_args_list))

    def test_main_advancing_after_upload_leaves_the_draft_unpublished(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + release.digest(p)}
                  for p in output.iterdir()]
        draft = {"id": 42, "tag_name": "v" + VERSION, "name": f"Aman managed T3 {VERSION} (Linux x64)",
                 "target_commitish": publisher, "draft": True, "assets": assets}
        actual_run = release.run
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "list_releases", side_effect=[[], [draft]]), \
                patch.object(release, "api", side_effect=[{"sha": publisher}, None, draft, {"sha": "f" * 40}]), \
                patch.object(release, "run", side_effect=lambda *args, **kwargs: actual_run(*args, **kwargs) if args[0] == "git" else b"") as run:
            with self.assertRaisesRegex(ValueError, "main advanced during draft upload"):
                release.publish(output, self.source)
            self.assertFalse(any(call.args[:3] == ("gh", "api", "--method") for call in run.call_args_list))

    def test_wrong_created_tag_fails_before_any_release_attestation(self):
        output = self.make_package()
        publisher = self.context["publisherCommit"]
        assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + release.digest(p)}
                  for p in output.iterdir()]
        draft = {"id": 42, "tag_name": "v" + VERSION, "name": f"Aman managed T3 {VERSION} (Linux x64)",
                 "target_commitish": publisher, "draft": True, "assets": assets}
        actual_run = release.run
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_SHA": publisher, "AMAN_MANAGED_IMMUTABILITY_VERIFIED": "true"}), \
                patch.object(release, "list_releases", side_effect=[[], [draft]]), \
                patch.object(release, "api", side_effect=[{"sha": publisher}, None, draft, {"sha": publisher}, None,
                                                        dict(draft, draft=False, immutable=True),
                                                        {"object": {"type": "commit", "sha": "f" * 40}}]), \
                patch.object(release, "run", side_effect=lambda *args, **kwargs: actual_run(*args, **kwargs) if args[0] == "git" else b"") as run:
            with self.assertRaisesRegex(ValueError, "published canonical tag differs"):
                release.publish(output, self.source)
            self.assertFalse(any(call.args[:3] == ("gh", "release", "verify") and "--help" not in call.args
                                 for call in run.call_args_list))

    def test_publish_does_not_expose_nonmanaged_or_corrupted_archive(self):
        output = self.make_package()
        (output / f"t3-{VERSION}-linux-x64.tar.gz").write_bytes(b"broken")
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": release.REPOSITORY}), \
                patch.object(release, "api") as api, patch.object(release, "run") as run:
            with self.assertRaises((ValueError, tarfile.TarError)):
                release.publish(output, self.root)
            api.assert_not_called()
            run.assert_not_called()


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        release.git(self.root, "init", "-b", "main")
        release.git(self.root, "config", "user.name", "Test")
        release.git(self.root, "config", "user.email", "test@example.invalid")
        (self.root / "server.txt").write_text("before\n")
        self.base = self.commit()

    def commit(self):
        release.git(self.root, "add", "--all")
        release.git(self.root, "commit", "-m", "fixture")
        return release.git(self.root, "rev-parse", "HEAD")

    def test_exact_patch_is_applied_to_new_upstream(self):
        (self.root / "server.txt").write_text("fixed\n")
        patched = self.commit()
        release.git(self.root, "checkout", "--detach", self.base)
        (self.root / "upstream.txt").write_text("new upstream\n")
        upstream = self.commit()
        release.apply_maintained_patch(self.root, self.base, patched, upstream)
        self.assertEqual((self.root / "server.txt").read_text(), "fixed\n")
        self.assertEqual((self.root / "upstream.txt").read_text(), "new upstream\n")

    def test_conflict_is_not_fuzzed_merged_or_published(self):
        (self.root / "server.txt").write_text("fixed\n")
        patched = self.commit()
        release.git(self.root, "checkout", "--detach", self.base)
        (self.root / "server.txt").write_text("different upstream\n")
        upstream = self.commit()
        with self.assertRaises(subprocess.CalledProcessError):
            release.apply_maintained_patch(self.root, self.base, patched, upstream)
        self.assertEqual(release.git(self.root, "rev-parse", "HEAD"), upstream)
        self.assertEqual((self.root / "server.txt").read_text(), "different upstream\n")
        self.assertEqual(release.git(self.root, "status", "--porcelain"), "")

    def test_sealed_source_is_deterministic_and_omits_untracked_public_env(self):
        for name in ("apps/server", "apps/desktop", "apps/web", "packages/contracts"):
            path = self.root / name / "package.json"
            path.parent.mkdir(parents=True)
            release.write_json(path, {"version": VERSION})
        upstream = self.commit()
        (self.root / "server.txt").write_text("fixed\n")
        (self.root / ".env").write_text("PUBLIC_CONFIG=example\n")
        prepared = context()
        prepared["upstreamSourceCommit"] = upstream
        file = self.root.parent / (self.root.name + "-context.json")
        self.addCleanup(lambda: file.unlink(missing_ok=True))
        release.write_json(file, prepared)
        first = release.seal_source(self.root, file)
        self.assertNotIn(".env", release.git(self.root, "ls-tree", "--name-only", "HEAD"))
        release.git(self.root, "reset", "--hard", upstream)
        (self.root / "server.txt").write_text("fixed\n")
        release.write_json(file, prepared)
        second = release.seal_source(self.root, file)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
