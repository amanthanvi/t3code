// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASES_PAGE_URL,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  type CliArchivePlatformKey,
  parseChecksums,
} from "@t3tools/shared/cliRelease";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import {
  decodeManagedRuntimeBuild,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_STATE_FILE,
} from "./serviceProtocol.ts";

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT = Duration.minutes(1);
const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";
// Separate layers share one install lock across this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimeCommand(paths: PinnedRuntimePaths): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return { command: paths.entryPath, args: [] };
}

const runtimeSourcePattern = /^[a-f0-9]{64}$/;
const managedBuildFile = "managed-build.json";
const managedReceiptFile = ".managed-install.json";

/** Only public GitHub download roots support immutable release metadata through the GitHub API. */
export function githubReleaseRepository(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim());
    if (
      url.origin !== "https://github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/releases\/download\/?$/.exec(
      url.pathname,
    );
    return match === null ? undefined : `${match[1]}/${match[2]}`;
  } catch {
    return undefined;
  }
}

/** Public releases retain their legacy location; every other source gets its own cache. */
export function runtimeSourceForReleaseBaseUrl(baseUrl?: string): string | undefined {
  const normalize = (value: string) => {
    const url = new URL(value.trim());
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  };
  const official = normalize(`${CLI_RELEASES_PAGE_URL}/download`);
  const source = normalize(baseUrl?.trim() || official);
  return source === official
    ? undefined
    : NodeCrypto.createHash("sha256").update(source).digest("hex");
}

export function pinnedRuntimeVersionsDir(
  path: Path.Path,
  baseDir: string,
  runtimeSource?: string,
): string {
  if (runtimeSource === undefined) return path.join(baseDir, PINNED_RUNTIME_DIR, "versions");
  if (!runtimeSourcePattern.test(runtimeSource)) throw new Error("Invalid runtime source key");
  return path.join(baseDir, PINNED_RUNTIME_DIR, "sources", runtimeSource, "versions");
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
  runtimeSource?: string,
): PinnedRuntimePaths {
  const versionDir = path.join(pinnedRuntimeVersionsDir(path, baseDir, runtimeSource), version);
  return {
    versionDir,
    entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export type PinnedRuntimeProgress =
  | { readonly stage: "download"; readonly received: number; readonly total: number | undefined }
  | { readonly stage: "verify" | "extract" | "validate" | "cached" };

/** Tar writes the executable before native packages; only a validated install gets a sentinel. */

interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly releaseBaseUrl?: string | undefined;
  readonly runtimeSource?: string | undefined;
  /** Reuse a cached runtime only while the release source still lists it, as a policy mirror does. */
  readonly requirePublishedRelease?: boolean;
  readonly onProgress?: (progress: PinnedRuntimeProgress) => void;
}

const fetchReleaseAsset = Effect.fn("cloud.pinned_runtime.fetch_release_asset")(function* (
  httpClient: HttpClient.HttpClient,
  url: string,
  step: string,
  onProgress?: (progress: PinnedRuntimeProgress) => void,
) {
  // Bound stalls while holding the install lock, but allow transfers that keep
  // receiving bytes to finish regardless of their total duration.
  return yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.timeout(PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT),
    Effect.flatMap(
      Effect.fn(function* (response) {
        const length = Number(response.headers["content-length"]);
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        let received = 0;
        onProgress?.({ stage: "download", received, total });
        const chunks = yield* response.stream.pipe(
          Stream.timeoutOrElse({
            duration: PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT,
            orElse: () => Stream.fail(new Cause.TimeoutError()),
          }),
          Stream.tap((chunk) =>
            Effect.sync(() => {
              received += chunk.byteLength;
              onProgress?.({ stage: "download", received, total });
            }),
          ),
          Stream.runCollect,
        );
        if (total === undefined && received > 0) {
          onProgress?.({ stage: "download", received, total: received });
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }),
    ),
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: cause._tag === "TimeoutError" ? `${step} (timed out)` : step,
          cause,
        }),
    ),
  );
});

const installFromArchive = Effect.fn("cloud.pinned_runtime.install_archive")(function* (
  input: PinnedRuntimeInstallInput,
  stagingDir: string,
) {
  const { fs, path } = input;
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  if (platformKey === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
    });
  }
  const httpClient = input.httpClient;
  input.onProgress?.({ stage: "download", received: 0, total: undefined });
  const { fileName, expected } = yield* publishedArchive(input, platformKey);
  const archive = yield* fetchReleaseAsset(
    httpClient,
    cliReleaseAssetUrl(input.version, fileName, input.releaseBaseUrl),
    "downloading the t3 release archive",
    input.onProgress,
  );
  input.onProgress?.({ stage: "verify" });
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", archive),
    catch: (cause) =>
      new PinnedRuntimeInstallError({ step: "verifying the t3 release archive", cause }),
  });
  if (Hex.encode(new Uint8Array(digest)) !== expected) {
    return yield* new PinnedRuntimeInstallError({
      step: "verifying the t3 release archive checksum",
    });
  }

  const archivePath = path.join(stagingDir, PINNED_RUNTIME_ARCHIVE_FILE);
  yield* fs
    .writeFile(archivePath, archive)
    .pipe(
      Effect.mapError(
        (cause) => new PinnedRuntimeInstallError({ step: "writing the t3 release archive", cause }),
      ),
    );
  input.onProgress?.({ stage: "extract" });
  const extractStep = "extracting the t3 release archive";
  // Strip the archive's stem directory so the executable lands at <versionDir>/t3.
  yield* input.runner
    .run({
      command: cliArchiveTarCommand(input.platform, process.env),
      args: ["-xf", archivePath, "-C", stagingDir, "--strip-components=1"],
      timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
    })
    .pipe(
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: extractStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PinnedRuntimeInstallError({
            step: extractStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
    );
  yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
  return expected;
});

/** The release's archive for this machine and its checksum; fails when the release lists none. */
const publishedArchive = Effect.fn("cloud.pinned_runtime.published_archive")(function* (
  input: PinnedRuntimeInstallInput,
  platformKey: CliArchivePlatformKey,
) {
  const repository =
    input.releaseBaseUrl === undefined ? undefined : githubReleaseRepository(input.releaseBaseUrl);
  if (
    repository !== undefined &&
    runtimeSourceForReleaseBaseUrl(input.releaseBaseUrl) !== undefined
  ) {
    const release = yield* fetchReleaseAsset(
      input.httpClient,
      `https://api.github.com/repos/${repository}/releases/tags/v${encodeURIComponent(input.version)}`,
      "downloading the t3 release immutability metadata",
    ).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              immutable: Schema.Boolean,
              tag_name: Schema.String,
              draft: Schema.optional(Schema.Boolean),
            }),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        isPinnedRuntimeInstallError(cause)
          ? cause
          : new PinnedRuntimeInstallError({
              step: "verifying managed release immutability",
              cause,
            }),
      ),
    );
    if (
      release.immutable !== true ||
      release.draft === true ||
      release.tag_name !== `v${input.version}`
    ) {
      return yield* new PinnedRuntimeInstallError({
        step: "verifying managed release immutability",
      });
    }
  }
  const fileName = cliArchiveFileName(input.version, platformKey);
  const checksums = parseChecksums(
    new TextDecoder().decode(
      yield* fetchReleaseAsset(
        input.httpClient,
        cliReleaseAssetUrl(input.version, CLI_RELEASE_CHECKSUMS_FILE, input.releaseBaseUrl),
        "downloading the t3 release checksums",
      ),
    ),
  );
  const expected = checksums.get(fileName);
  if (expected === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `finding ${fileName} in the t3 release checksums`,
    });
  }
  return { fileName, expected };
});

const managedReceiptJson = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    runtimeSource: Schema.String,
    version: Schema.String,
    archiveSha256: Schema.String,
    provenance: Schema.Unknown,
  }),
);

const readManagedBuild = Effect.fn("cloud.pinned_runtime.read_managed_build")(function* (
  input: PinnedRuntimeInstallInput,
  versionDir: string,
) {
  return yield* input.fs.readFileString(input.path.join(versionDir, managedBuildFile)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.flatMap((value) => {
      const provenance = decodeManagedRuntimeBuild(value);
      return provenance !== undefined && provenance.upstreamVersion === input.version
        ? Effect.succeed(provenance)
        : Effect.fail(
            new PinnedRuntimeInstallError({ step: "verifying managed build provenance" }),
          );
    }),
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({ step: "verifying managed build provenance", cause }),
    ),
  );
});

const verifyManagedReceipt = Effect.fn("cloud.pinned_runtime.verify_managed_receipt")(function* (
  input: PinnedRuntimeInstallInput,
  paths: PinnedRuntimePaths,
  source: string,
  expected: string,
) {
  const provenance = yield* readManagedBuild(input, paths.versionDir);
  yield* input.fs.readFileString(input.path.join(paths.versionDir, managedReceiptFile)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(managedReceiptJson)),
    Effect.filterOrFail(
      (receipt) => {
        const recordedBuild = decodeManagedRuntimeBuild(receipt.provenance);
        return (
          receipt.runtimeSource === source &&
          receipt.version === input.version &&
          receipt.archiveSha256 === expected &&
          recordedBuild !== undefined &&
          (
            [
              "schemaVersion",
              "distribution",
              "buildId",
              "upstreamVersion",
              "upstreamSourceCommit",
              "sourceCommit",
            ] as const
          ).every((field) => recordedBuild[field] === provenance[field])
        );
      },
      () => new PinnedRuntimeInstallError({ step: "verifying the managed runtime receipt" }),
    ),
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({ step: "verifying the managed runtime receipt", cause }),
    ),
  );
});

const isPinnedRuntimeInstallError = Schema.is(PinnedRuntimeInstallError);

/** Whether an install failed because the release source does not publish the version for this machine. */
export const isUnpublishedRelease = (error: unknown): error is PinnedRuntimeInstallError =>
  isPinnedRuntimeInstallError(error) &&
  (error.step.startsWith("finding ") ||
    (error.step.startsWith("downloading the t3 release") &&
      HttpClientError.isHttpClientError(error.cause) &&
      error.cause.response?.status === 404));

const cacheHasLinkedAncestor = Effect.fn("cloud.pinned_runtime.cache_has_linked_ancestor")(
  function* (
    input: {
      readonly fs: FileSystem.FileSystem;
      readonly path: Path.Path;
      readonly baseDir: string;
    },
    runtimeSource?: string,
    version?: string,
  ) {
    const { fs, path, baseDir } = input;
    const runtimeDir = path.join(baseDir, PINNED_RUNTIME_DIR);
    const ancestors =
      runtimeSource === undefined
        ? [runtimeDir, path.join(runtimeDir, "versions")]
        : [
            runtimeDir,
            path.join(runtimeDir, "sources"),
            path.join(runtimeDir, "sources", runtimeSource),
            pinnedRuntimeVersionsDir(path, baseDir, runtimeSource),
          ];
    if (version !== undefined)
      ancestors.push(path.join(pinnedRuntimeVersionsDir(path, baseDir, runtimeSource), version));
    for (const ancestor of ancestors) {
      if (yield* fs.readLink(ancestor).pipe(Effect.isSuccess)) return true;
    }
    return false;
  },
);

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs } = input;
  const source = runtimeSourceForReleaseBaseUrl(input.releaseBaseUrl);
  if (input.runtimeSource !== undefined && input.runtimeSource !== source) {
    return yield* new PinnedRuntimeInstallError({
      step: "matching the runtime source to its release feed",
    });
  }
  const paths = pinnedRuntimePaths(
    input.path,
    input.baseDir,
    input.version,
    input.platform,
    source,
  );
  if (yield* cacheHasLinkedAncestor(input, source, input.version)) {
    return yield* new PinnedRuntimeInstallError({
      step: "refusing a linked runtime cache directory",
    });
  }
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const alreadyPinned =
    entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version;
  if (alreadyPinned) {
    if (input.requirePublishedRelease === true || source !== undefined) {
      const platformKey = cliArchivePlatformKey(input.platform, input.arch);
      if (platformKey === undefined) {
        return yield* new PinnedRuntimeInstallError({
          step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
        });
      }
      const published = yield* publishedArchive(input, platformKey);
      if (source !== undefined)
        yield* verifyManagedReceipt(input, paths, source, published.expected);
    }
    input.onProgress?.({ stage: "cached" });
    yield* input.validate(paths);
    return paths;
  }
  if (versionDirExists) {
    yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "removing an incomplete pinned runtime",
            cause,
          }),
      ),
    );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, input.path.relative(paths.versionDir, paths.entryPath)),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    const archiveSha256 = yield* installFromArchive(input, stagingDir);
    if (source !== undefined) {
      const provenance = yield* readManagedBuild(input, stagingDir);
      const receipt = yield* Schema.encodeEffect(managedReceiptJson)({
        schemaVersion: 1,
        runtimeSource: source,
        version: input.version,
        archiveSha256,
        provenance,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording managed runtime provenance", cause }),
        ),
      );
      yield* fs.writeFileString(input.path.join(stagingDir, managedReceiptFile), receipt).pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "recording managed runtime provenance",
              cause,
            }),
        ),
      );
    }

    input.onProgress?.({ stage: "validate" });
    yield* input.validate(stagingPaths);
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    const published = yield* fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            publishedSentinel.value.trim() === input.version
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!published) {
      if (source !== undefined) yield* verifyManagedReceipt(input, paths, source, archiveSha256);
      yield* input.validate(paths);
    }
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));

const PINNED_RUNTIME_PRUNED_PREFIX = ".pruned-";
/**
 * Another process may have just published a runtime it has not yet pointed anything at: an
 * update, a downgrade, or the install script between unpacking and linking. The install lock only
 * covers this process, so recently completed runtimes are left for a later prune.
 */
const PINNED_RUNTIME_PRUNE_GRACE = Duration.hours(1);
/**
 * One `t3` launcher path per line, appended by the install scripts and by any prune that finds a
 * launcher on PATH. A service does not see the installer's `T3CODE_INSTALL_BIN_DIR` or the
 * interactive PATH, so this is how it finds a custom one, including installs that predate the file.
 */
const PINNED_RUNTIME_LAUNCHERS_FILE = "launchers";

/**
 * Starts on a fresh line whatever the file ends with when the append lands: another process's
 * append may have been cut short since this one read the file. Readers skip the blank lines.
 */
const launcherRecords = (launchers: ReadonlyArray<string>) =>
  `\n${launchers.map((launcher) => `${launcher}\n`).join("")}`;

export function launcherOwnsVersionsDir(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Only the legacy cache or a validated source namespace belongs to this home. */
export function launcherOwnsRuntimePath(
  path: Path.Path,
  baseDir: string,
  candidate: string,
): boolean {
  if (launcherOwnsVersionsDir(path, pinnedRuntimeVersionsDir(path, baseDir), candidate))
    return true;
  const relative = path.relative(
    path.join(baseDir, PINNED_RUNTIME_DIR, "sources"),
    path.resolve(candidate),
  );
  const [source, versions, ...rest] = relative.split(path.sep);
  return (
    source !== undefined &&
    runtimeSourcePattern.test(source) &&
    versions === "versions" &&
    rest.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.startsWith("..")
  );
}

/**
 * `t3 update` repoints the launcher it was started through, which may be on neither PATH nor the
 * default bin dir. Unrecorded, the next prune would remove the runtime it now points at.
 */
export const recordPinnedRuntimeLauncher = Effect.fn("cloud.pinned_runtime.record_launcher")(
  function* (input: { readonly baseDir: string; readonly launcher: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launchersFile = path.join(
      input.baseDir,
      PINNED_RUNTIME_DIR,
      PINNED_RUNTIME_LAUNCHERS_FILE,
    );
    // Prune may run in another process, such as the service, whose working directory differs.
    const launcher = path.resolve(input.launcher);
    const recorded = yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => ""));
    if (recorded.split(/\r?\n/).includes(launcher)) return;
    yield* fs.writeFileString(launchersFile, launcherRecords([launcher]), { flag: "a" });
  },
);

/** The executable a `t3.cmd` shim written by the install script or `t3 update` runs. */
export const windowsShimTarget = (contents: string) => /^"([^"]+)"/m.exec(contents)?.[1];

/** Where the `t3` launchers written by the install scripts and `t3 update` point. */
const shellLauncherTargets = Effect.fn("cloud.pinned_runtime.shell_launcher_targets")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const launcherName = platform === "win32" ? "t3.cmd" : "t3";
  const launchersFile = path.join(baseDir, PINNED_RUNTIME_DIR, PINNED_RUNTIME_LAUNCHERS_FILE);
  const recorded = (yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => "")))
    .split(/\r?\n/)
    .filter((launcher) => launcher.trim().length > 0);
  const found = [
    environment["T3CODE_INSTALL_BIN_DIR"] || path.join(home, ".local", "bin"),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(platform === "win32" ? ";" : ":"),
  ]
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, launcherName));
  const realBaseDir = yield* fs.realPath(baseDir).pipe(Effect.orElseSucceed(() => baseDir));
  const unrecorded: Array<string> = [];
  const targets: Array<string> = [];
  for (const launcher of [...recorded, ...found]) {
    const target =
      platform === "win32"
        ? yield* fs.readFileString(launcher).pipe(
            Effect.map(windowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          )
        : // Fully resolved, through chained links and a symlinked T3 home alike.
          yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined));
    if (target === undefined) continue;
    targets.push(target);
    if (
      (launcherOwnsRuntimePath(path, baseDir, target) ||
        launcherOwnsRuntimePath(path, realBaseDir, target)) &&
      !recorded.includes(launcher) &&
      !unrecorded.includes(launcher)
    ) {
      unrecorded.push(launcher);
    }
  }
  if (unrecorded.length > 0) {
    yield* fs
      .writeFileString(launchersFile, launcherRecords(unrecorded), { flag: "a" })
      .pipe(Effect.ignore);
  }
  return targets;
});

/**
 * Resolved executables rather than command lines: a server started through the `t3` symlink
 * shows up as `t3 serve`, possibly from another T3 home that runs this home's runtimes. Windows
 * has no symlink launcher, and its `t3.cmd` shim runs the absolute path, so command lines do there.
 */
const runningExecutables = Effect.fn("cloud.pinned_runtime.running_executables")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") {
    const pids = yield* fs.readDirectory("/proc").pipe(Effect.option);
    if (Option.isNone(pids)) return Option.none<string>();
    const executables: Array<string> = [];
    for (const pid of pids.value) {
      if (!/^\d+$/.test(pid)) continue;
      // Unreadable ones belong to other users or are this user's non-dumpable daemons (systemd
      // --user, ssh-agent). Neither runs a t3 runtime, and bailing on them would never prune.
      const executable = yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.option);
      if (Option.isSome(executable)) executables.push(executable.value);
    }
    return executables.length === 0 ? Option.none<string>() : Option.some(executables.join("\n"));
  }
  const result = yield* runner
    .run({
      ...(platform === "win32"
        ? {
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
            ],
          }
        : { command: "lsof", args: ["-nP", "-w", "-d", "txt", "-F", "n"] }),
      timeout: Duration.seconds(10),
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(Effect.option);
  return Option.isSome(result) && result.value.code === 0 && result.value.stdout.length > 0
    ? Option.some(result.value.stdout)
    : Option.none<string>();
});

const selectUnusedRuntimes = Effect.fn("cloud.pinned_runtime.select_unused")(function* (input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
  readonly runtimeSource?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir, input.runtimeSource);
  if (yield* cacheHasLinkedAncestor({ fs, path, baseDir: input.baseDir }, input.runtimeSource)) {
    return new Set<string>();
  }
  const entries = yield* fs.readDirectory(versionsDir).pipe(Effect.orElseSucceed(() => []));
  // An interrupted prune has already renamed its runtime out of the way.
  const pruned = new Set(
    entries
      .filter((entry) => entry.startsWith(PINNED_RUNTIME_PRUNED_PREFIX))
      .map((entry) => path.join(versionsDir, entry)),
  );

  const settledBefore =
    (yield* Clock.currentTimeMillis) - Duration.toMillis(PINNED_RUNTIME_PRUNE_GRACE);
  const completed: Array<string> = [];
  for (const version of entries) {
    if (!isExactServiceVersion(version)) continue;
    const versionDir = path.join(versionsDir, version);
    const sentinelPath = path.join(versionDir, ".install-complete");
    const isLink = yield* fs.readLink(versionDir).pipe(Effect.isSuccess);
    const sentinel = yield* fs.readFileString(sentinelPath).pipe(Effect.option);
    const completedAt = yield* fs.stat(sentinelPath).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !isLink &&
      Option.isSome(sentinel) &&
      sentinel.value.trim() === version &&
      completedAt !== undefined &&
      completedAt < settledBefore
    ) {
      completed.push(version);
    }
  }
  if (completed.length === 0) return pruned;

  const keep = new Set(input.keep);
  const stateText = yield* fs
    .readFileString(path.join(input.baseDir, PINNED_RUNTIME_DIR, SERVICE_STATE_FILE))
    .pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? Option.none<string>() : undefined),
      ),
    );
  // State this version cannot read may reference runtimes in ways it does not know.
  if (stateText === undefined) return pruned;
  if (Option.isSome(stateText)) {
    const state = parseServiceState(stateText.value);
    if (state === undefined) return pruned;
    keep.add(state.activeVersion);
    if (state.update !== undefined) {
      keep.add(state.update.fromVersion);
      keep.add(state.update.targetVersion);
    }
  }
  const executables = yield* runningExecutables();
  // Without a process list, a runtime in use would look unused.
  if (Option.isNone(executables)) return pruned;
  const platform = yield* HostProcess.Platform;
  // Windows paths are case-insensitive, and shims and process lists need not agree on case.
  const foldCase = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const references = [
    executables.value,
    ...(yield* shellLauncherTargets(input.baseDir)),
    ...input.references,
  ].map(foldCase);
  // Process executables are resolved, so they name the real path of a symlinked T3 home.
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));

  for (const version of completed) {
    const versionDir = path.join(versionsDir, version);
    const prefixes = [versionDir, path.join(realVersionsDir, version)].map((dir) =>
      foldCase(dir + path.sep),
    );
    if (
      keep.has(version) ||
      references.some((reference) => prefixes.some((prefix) => reference.includes(prefix)))
    ) {
      continue;
    }
    const target = path.join(versionsDir, `${PINNED_RUNTIME_PRUNED_PREFIX}${version}`);
    // Renaming first means an interrupted removal never leaves a partial tree that still carries
    // its sentinel and would pass for a complete install.
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(fs.rename(versionDir, target)),
      Effect.andThen(Effect.sync(() => pruned.add(target))),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { version, cause }),
      ),
    );
  }
  return pruned;
});

/**
 * Keep runtimes named by callers, service state, running processes, launchers, or references,
 * and anything published within an hour. Only prune completed runtimes; leave staging
 * directories, symlinks, and unexpected entries untouched.
 */
export const prunePinnedRuntimes = Effect.fn("cloud.pinned_runtime.prune")(function* (input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references?: ReadonlyArray<string>;
  readonly runtimeSource?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Only selection and the renames race an install; deleting renamed trees can take a while.
  const pruned = yield* pinnedRuntimeInstallLock.withPermit(
    selectUnusedRuntimes({ ...input, references: input.references ?? [] }),
  );
  const removed: Array<string> = [];
  for (const target of pruned) {
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(
        Effect.sync(() =>
          removed.push(path.basename(target).slice(PINNED_RUNTIME_PRUNED_PREFIX.length)),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { target, cause }),
      ),
    );
  }
  return removed;
});
