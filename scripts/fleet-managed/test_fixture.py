import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import subprocess
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location("coordination_fixture", Path(__file__).with_name("fixture.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
publisher = fixture.publisher
RELEASE = "0.1.8-nightly.20261106.4247"
PATCH = "c" * 40


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        publisher.git(self.source, "init", "-b", "main")
        publisher.git(self.source, "config", "user.name", "Fixture test")
        publisher.git(self.source, "config", "user.email", "test@example.invalid")
        for name in ("apps/server", "apps/desktop", "apps/web", "packages/contracts"):
            path = self.source / name / "package.json"
            path.parent.mkdir(parents=True)
            publisher.write_json(path, {"version": RELEASE})
        packager = self.source / "scripts/build-cli-archive.ts"
        packager.parent.mkdir()
        packager.write_text('const output = `${yield* encodeJsonString(provenance)}\\n`;\n')
        client = self.source / "apps/server/src/cloud/serviceLauncherClient.ts"
        client.parent.mkdir(parents=True)
        client.write_text('''const prepareTrial =
    pending !== undefined
      ? exchange(
          { type: "prepared", updateId: pending.id },
        ).pipe(
          Effect.map(reply => reply),
        )
      : Effect.succeed(outcome);
''')
        publisher.git(self.source, "add", "--all")
        publisher.git(self.source, "commit", "-m", "fixture upstream")
        self.upstream = publisher.git(self.source, "rev-parse", "HEAD")
        self.context = self.root / "context.json"

    def context_for(self, variant="v1"):
        value = {"schemaVersion": 1, "distribution": publisher.DISTRIBUTION,
                 "upstreamVersion": RELEASE, "upstreamSourceCommit": self.upstream,
                 "patchBaseCommit": "a" * 40, "patchSourceCommit": PATCH,
                 "publisherCommit": "d" * 40, "sourceDateEpoch": "1793923200",
                 "testFixture": True, "sourceRelease": RELEASE, "fixtureVariant": variant}
        publisher.write_json(self.context, value)
        return value

    def seal(self, variant="v1"):
        self.context_for(variant)
        version = fixture.VERSIONS[variant]
        for path in self.source.glob("**/package.json"):
            publisher.write_json(path, {"version": version})
        return fixture.seal(self.source, self.context)

    def test_only_three_exact_preview_versions_are_allowed(self):
        self.assertEqual(list(fixture.VERSIONS.values()), [f"0.1.8-preview.20261106.{n}" for n in (9001, 9002, 9003)])
        self.context_for()
        value = publisher.read_json(self.context)
        value["upstreamVersion"] = RELEASE
        with self.assertRaisesRegex(ValueError, "preview"):
            fixture.manifest(value)

    def test_preview_versions_cannot_mask_the_native_ownership_test(self):
        # The official .4247 ownership heuristic refuses selected service versions below 0.1.0.
        versions = list(fixture.VERSIONS.values())
        self.assertTrue(all(tuple(map(int, value.split("-", 1)[0].split("."))) >= (0, 1, 0) for value in versions))
        self.assertTrue(all(value.startswith("0.1.8-preview.") for value in versions))
        self.assertEqual(versions, sorted(set(versions)))
        self.assertTrue(all(value > RELEASE for value in versions))

    def test_prepare_uses_only_the_requested_published_source_and_exact_patch(self):
        config = {"patchBaseCommit": "a" * 40}
        def prepared(config, selection, directory, context):
            self.assertEqual(selection, {"version": RELEASE, "patchSourceCommit": PATCH})
            publisher.write_json(context, {"upstreamVersion": RELEASE})
        with patch.object(publisher, "api", side_effect=[{"tag_name": "v" + RELEASE, "published_at": "today"}, {"sha": PATCH}]), \
                patch.object(publisher, "prepare", side_effect=prepared) as prepare:
            self.assertEqual(fixture.prepare(config, RELEASE, PATCH, "v2", self.source, self.context), fixture.VERSIONS["v2"])
            self.assertEqual(prepare.call_count, 1)
        self.assertEqual(publisher.read_json(self.context)["sourceRelease"], RELEASE)

    def test_invalid_or_unpublished_inputs_never_prepare_source(self):
        for version, commit, responses in (
            (RELEASE, "main", []), ("../source", PATCH, []),
            (RELEASE, PATCH, [None]),
            (RELEASE, PATCH, [{"tag_name": "v" + RELEASE, "published_at": "today", "draft": True}]),
            (RELEASE, PATCH, [{"tag_name": "v" + RELEASE, "published_at": "today"}, {"sha": "e" * 40}]),
        ):
            with self.subTest(version=version, commit=commit, responses=responses), \
                    patch.object(publisher, "api", side_effect=responses), patch.object(publisher, "prepare") as prepare:
                with self.assertRaises(ValueError):
                    fixture.prepare({}, version, commit, "v1", self.source, self.context)
                prepare.assert_not_called()

    def test_sealed_source_and_manifest_identify_each_variant_and_fault(self):
        for variant in fixture.VERSIONS:
            with self.subTest(variant=variant):
                publisher.git(self.source, "reset", "--hard", self.upstream)
                result = self.seal(variant)
                self.assertIs(result["testFixture"], True)
                self.assertEqual(result["sourceRelease"], RELEASE)
                self.assertEqual(result["upstreamVersion"], fixture.VERSIONS[variant])
                self.assertEqual(result["sourceCommit"], publisher.git(self.source, "rev-parse", "HEAD"))
                source = (self.source / "apps/server/src/cloud/serviceLauncherClient.ts").read_text()
                self.assertEqual(fixture.FAULT in source, variant == "fault-v3")
                if variant == "fault-v3":
                    self.assertLess(source.index("pending !== undefined"), source.index(fixture.FAULT))
                    self.assertLess(source.index(fixture.FAULT), source.index("exchange("))
                    self.assertIn(": Effect.succeed(outcome)", source)
                packager = publisher.git(self.source, "show", "HEAD:scripts/build-cli-archive.ts")
                self.assertIn('"testFixture":true', packager)

    def test_fault_or_packager_source_drift_fails_before_sealing(self):
        self.context_for("fault-v3")
        client = self.source / "apps/server/src/cloud/serviceLauncherClient.ts"
        client.write_text(client.read_text().replace("pending !== undefined", "pending != null"))
        with self.assertRaisesRegex(ValueError, "fault anchor"):
            fixture.seal(self.source, self.context)
        self.assertEqual(publisher.git(self.source, "rev-parse", "HEAD"), self.upstream)

    def test_pending_fault_runs_before_exchange_and_does_not_touch_normal_startup(self):
        self.seal("fault-v3")
        source = (self.source / "apps/server/src/cloud/serviceLauncherClient.ts").read_text()
        program = '''
const fx = run => ({run, pipe(...ops) { return ops.reduce((value, op) => op(value), this); }});
const Effect = {
  die: message => fx(() => { throw Error(message); }),
  andThen: (first, next) => fx(() => { first.run(); return next.run(); }),
  map: f => self => fx(() => f(self.run())),
  succeed: value => fx(() => value)
};
let exchanges = 0;
const exchange = () => fx(() => { exchanges++; return "committed"; });
const outcome = "normal startup";
const results = [];
for (const pending of [undefined, {id: "pending-update"}]) {
''' + source + '''
  try { results.push({value: prepareTrial.run(), exchanges}); }
  catch (error) { results.push({error: error.message, exchanges}); }
}
process.stdout.write(JSON.stringify(results));
'''
        result = subprocess.run(["node", "--input-type=module"], input=program, text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), [{"value": "normal startup", "exchanges": 0},
                                                    {"error": fixture.FAULT, "exchanges": 0}])

    def test_fixture_labels_do_not_trigger_the_real_useless_spread_rule(self):
        self.seal()
        packager = (self.source / "scripts/build-cli-archive.ts").read_text()
        self.assertIn('encodeJsonString({ ...provenance, "testFixture":true,', packager)
        self.assertNotIn('...{"testFixture"', packager)

    def test_subprocess_diagnostic_exposes_only_operation_status_and_known_codes(self):
        secret = "ghp_SENTINEL_AUTH_TOKEN_DO_NOT_EMIT"
        error = subprocess.CalledProcessError(1, ["/usr/bin/git", "commit", "--message", secret],
                    output=f"Authorization: Bearer {secret}\nunicorn(no-useless-spread)\nTS2345\n".encode(),
                    stderr=f"TOKEN={secret}\nt3code(no-test-timeout) eslint(no-unused-vars)\nVITE+ - pre-commit script failed (code 1)")
        result = fixture.subprocess_diagnostic(error)
        self.assertIs(fixture.subprocess_diagnostic, publisher.subprocess_diagnostic)
        self.assertEqual(result, {"operation": "git.commit", "help": False, "exitCode": 1,
                                 "ruleCodes": ["TS2345", "eslint(no-unused-vars)", "t3code(no-test-timeout)", "unicorn(no-useless-spread)"],
                                 "httpStatuses": [], "githubClass": None,
                                 "precommitFailed": True})
        emitted = json.dumps(result)
        for value in (secret, "Authorization", "Bearer", "TOKEN=", "/usr/bin", "--message"):
            self.assertNotIn(value, emitted.replace("precommitFailed", ""))
        unknown = subprocess.CalledProcessError(2, ["/tmp/" + secret], output="unrelated output", stderr=b"invalid bytes \xff")
        self.assertEqual(fixture.subprocess_diagnostic(unknown), {"operation": "subprocess", "help": False, "exitCode": 2,
                                                               "ruleCodes": [], "httpStatuses": [], "githubClass": None,
                                                               "precommitFailed": False})

    def bundle(self):
        managed = self.seal()
        version = managed["upstreamVersion"]
        archive = self.root / "fixture.tar.gz"
        contents = {"t3": b"executable", "client/index.html": b"client", "resource-monitor/linux-x64/t3-resource-monitor": b"monitor",
                    "package.json": json.dumps({"version": version, "serviceOwnershipProtocol": 1}).encode(),
                    "managed-build.json": json.dumps(managed).encode()}
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in contents.items():
                member = tarfile.TarInfo(f"t3-{version}-linux-x64/{name}")
                member.size, member.mode = len(data), 0o755 if name == "t3" else 0o644
                tar.addfile(member, io.BytesIO(data))
        output = self.root / "bundle"
        fixture.package(self.context, archive, output, self.source)
        return output

    def test_bundle_binds_real_sealed_source_archive_and_binary_digest(self):
        output = self.bundle()
        provenance = fixture.verify(output)
        self.assertEqual(provenance["sourceCommit"], publisher.git(self.source, "rev-parse", "HEAD"))
        self.assertIs(provenance["testFixture"], True)
        with self.assertRaisesRegex(ValueError, "must not exist"):
            fixture.package(self.context, self.root / "fixture.tar.gz", output, self.source)
        (output / "source-commit.txt").write_text("another source")
        with self.assertRaisesRegex(ValueError, "source commit"):
            fixture.verify(output)

    def test_fixture_provenance_cannot_claim_production_or_another_source_release(self):
        self.seal()
        value = publisher.read_json(self.context)
        for changes in ({"testFixture": False}, {"sourceRelease": "latest"}, {"fixtureVariant": "production"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                fixture.manifest(dict(value, **changes))

    def test_cli_and_workflow_cannot_publish_or_request_write_credentials(self):
        with patch.object(publisher, "publish") as publish, self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
            fixture.main(["publish"])
        publish.assert_not_called()
        workflow = (Path(__file__).parents[2] / ".github/workflows/fleet-coordination-fixtures.yml").read_text()
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertNotRegex(workflow, r"contents: write|secrets\.|gh release|git push|release.py publish|schedule:|workflow_run:")
        self.assertIn("actions/upload-artifact@v7", workflow)

    def test_read_api_authentication_is_scoped_to_source_preparation(self):
        workflow = (Path(__file__).parents[2] / ".github/workflows/fleet-coordination-fixtures.yml").read_text()
        steps = workflow.split("\n      - ")
        prepare = next(step for step in steps if "fixture.py prepare" in step)
        self.assertIn("GH_TOKEN: ${{ github.token }}", prepare)
        self.assertEqual(workflow.count("GH_TOKEN:"), 1)
        self.assertEqual(workflow.count("${{ github.token }}"), 1)
        self.assertNotIn("GITHUB_ENV", prepare)
        for step in steps:
            if step != prepare:
                self.assertNotIn("GH_TOKEN", step)


if __name__ == "__main__":
    unittest.main()
