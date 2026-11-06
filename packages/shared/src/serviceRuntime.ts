// Plain JavaScript dependencies only: shared with the standalone native launcher.
export const SERVICE_OWNERSHIP_PROTOCOL = 1 as const;

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_SERVICE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export const isExactServiceVersion = (version: string): boolean =>
  EXACT_SERVICE_VERSION.test(version);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ManagedRuntimeBuild {
  readonly schemaVersion: 1;
  readonly distribution: string;
  readonly buildId: string;
  readonly upstreamVersion: string;
  readonly upstreamSourceCommit: string;
  readonly sourceCommit: string;
}

export function decodeManagedRuntimeBuild(value: unknown): ManagedRuntimeBuild | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.distribution !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(value.distribution) ||
    typeof value.buildId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/.test(value.buildId) ||
    typeof value.upstreamVersion !== "string" ||
    !isExactServiceVersion(value.upstreamVersion) ||
    typeof value.upstreamSourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.upstreamSourceCommit) ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    return undefined;
  return {
    schemaVersion: 1,
    distribution: value.distribution,
    buildId: value.buildId,
    upstreamVersion: value.upstreamVersion,
    upstreamSourceCommit: value.upstreamSourceCommit,
    sourceCommit: value.sourceCommit,
  };
}
