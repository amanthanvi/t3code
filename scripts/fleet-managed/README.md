# Aman managed Linux runtime publisher

This server-only channel carries the reviewed SSH/service ownership patch onto
published upstream nightlies. It builds Linux x64 only. Mac and Windows desktop
applications retain their normal features and official update channel.

The release origin is `https://github.com/amanthanvi/t3code/releases/download`.
The native managed installer requests `/vVERSION/t3-VERSION-linux-x64.tar.gz`
and its `SHA256SUMS`. The canonical version expresses upstream compatibility;
`managed-build.json` identifies the separate Aman distribution, exact build
source, and upstream source. These archives are not official T3 artifacts.

## Enable publication

Before enabling this workflow, publish and review the maintained patch branch
named in `config.json`. Its fixed base must remain an ancestor of the patch
head. A patch conflict, missing required test, failed build, or absent managed
archive stops publication. The workflow resolves the branch to one immutable
SHA before preparing source, and never substitutes an unpatched archive.

Clean Linux CI installs every workspace with `vp install --frozen-lockfile`,
then runs the unchanged `check:changed` against the exact selected upstream
commit. Each required ownership/update/handoff regression must exist in that
diff, so the checker's normal changed-test selection includes it. Formatting,
lint, both Knip passes, affected typechecks and selected tests must all pass
before building or publishing. No mobile config or license check is disabled.

An administrator must enable immutable releases in this public repository and
read back that setting using their existing administrative access. Only after
that verification, set the nonsecret Actions repository variable
`AMAN_MANAGED_IMMUTABILITY_VERIFIED` to `true`. The ordinary `GITHUB_TOKEN`
cannot read the administrative setting endpoint. This variable records the
setup prerequisite; it does not replace actual release verification.

Publication checks uploaded sizes/digests, then requires the published release
to report `immutable: true` and verifies GitHub's native release and every asset
attestation. If a release instead remains mutable, it is immediately retracted
to a draft and the job fails. Managed consumers must also refuse mutable release
metadata before installing or adopting cached bytes. A failed retraction needs
operator intervention; no artifact is automatically adopted by this workflow.

## Source and release identity

The full exact prepared source and its raw Git commit object are release assets,
with SHA-256 checksums and provenance. The build commit includes the maintained
patch and release package-version alignment. Its SHA is the archive manifest's
`sourceCommit`. The source tar's Git archive header and raw commit object bind
it to that same build identity.

The canonical `vVERSION` release tag points to the publisher workflow commit,
not to upstream or the prepared build commit; release notes say this explicitly.
This permits ordinary-token publication without permission to activate changed
upstream workflow files. Any preexisting canonical tag or release is refused,
never overwritten or repointed. A concurrent tag creation is checked again
before publishing the draft. Existing failed drafts require operator review.

The schedule builds the oldest missing published nightly at or above
`minimumVersion`, so it drains gaps rather than silently dropping releases.
Manual dispatch may select a particular already-published upstream nightly.
An official desktop may offer a new release before its managed build finishes;
the native updater must keep the current server and report unavailable until
the tested managed artifact exists. No route pause is required.

Run publisher checks locally with:

```sh
python3 -B -m unittest discover -s scripts/fleet-managed -p 'test_*.py'
```

No local command publishes unless `release.py publish` is explicitly invoked.
No code path deletes releases, repoints tags, or replaces existing asset bytes.
