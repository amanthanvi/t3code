// @effect-diagnostics nodeBuiltinImport:off - the resolver is captured by a driver and read at independent session spawns.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { parse } from "smol-toml";

import { expandHomePath } from "../../pathExpansion.ts";

async function validateCatalog(catalogPath: string): Promise<void> {
  const catalogStat = await NodeFSP.stat(catalogPath);
  if (
    !catalogPath.endsWith(".json") ||
    catalogPath.endsWith(".meta.json") ||
    !catalogStat.isFile() ||
    catalogStat.size > 64 * 1024 * 1024
  ) {
    throw new Error("model_catalog_json must point to a file");
  }
  const catalogBytes = await NodeFSP.readFile(catalogPath);
  const catalog: unknown = JSON.parse(catalogBytes.toString("utf8"));
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    !("models" in catalog) ||
    !Array.isArray(catalog.models) ||
    catalog.models.length === 0 ||
    !catalog.models.every(
      (model: unknown) =>
        typeof model === "object" &&
        model !== null &&
        "slug" in model &&
        typeof model.slug === "string" &&
        model.slug.length > 0,
    )
  ) {
    throw new Error("model_catalog_json must contain a non-empty models list");
  }
  const sidecarPath = catalogPath.replace(/\.json$/i, ".meta.json");
  try {
    if ((await NodeFSP.stat(sidecarPath)).size > 1024 * 1024) {
      throw new Error("model_catalog_json metadata is too large");
    }
    const sidecar: unknown = JSON.parse(await NodeFSP.readFile(sidecarPath, "utf8"));
    if (
      typeof sidecar !== "object" ||
      sidecar === null ||
      !("model_count" in sidecar) ||
      sidecar.model_count !== catalog.models.length ||
      !("sha256" in sidecar) ||
      sidecar.sha256 !== NodeCrypto.createHash("sha256").update(catalogBytes).digest("hex")
    ) {
      throw new Error("model_catalog_json metadata does not match the catalog");
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

export function makeCodexCatalogSourceResolver(sourcePath: string, homePath?: string) {
  if (!sourcePath) {
    return {
      candidate: Effect.succeed(undefined),
      accepted: Effect.succeed(undefined),
      accept: (_catalogPath: string | undefined) => Effect.void,
    };
  }

  const absoluteSourcePath = NodePath.resolve(
    homePath ? expandHomePath(homePath) : process.cwd(),
    expandHomePath(sourcePath),
  );
  let acceptedCatalog: string | undefined;

  const accepted = Effect.tryPromise(async () => {
    if (!acceptedCatalog) return undefined;
    await validateCatalog(acceptedCatalog);
    return acceptedCatalog;
  }).pipe(Effect.orElseSucceed(() => undefined));

  const candidate = Effect.tryPromise(async () => {
    if ((await NodeFSP.stat(absoluteSourcePath)).size > 1024 * 1024) {
      throw new Error("Codex catalog source is too large");
    }
    const source = parse(await NodeFSP.readFile(absoluteSourcePath, "utf8"));
    const configured = source.model_catalog_json;
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error("model_catalog_json must be a non-empty string");
    }
    const catalogPath = NodePath.resolve(
      NodePath.dirname(absoluteSourcePath),
      expandHomePath(configured),
    );
    await validateCatalog(catalogPath);
    return catalogPath;
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Codex catalog source unavailable; retaining last known catalog.", {
        sourcePath: absoluteSourcePath,
      }).pipe(Effect.andThen(accepted)),
    ),
  );

  return {
    candidate,
    accepted,
    accept: (catalogPath: string | undefined) =>
      Effect.sync(() => {
        if (catalogPath) acceptedCatalog = catalogPath;
      }),
  };
}

export const probeCodexCatalogSource = Effect.fn("probeCodexCatalogSource")(function* <
  T extends {
    readonly status: string;
    readonly models: ReadonlyArray<{ readonly isCustom?: boolean }>;
  },
  E,
  R,
>(
  source: ReturnType<typeof makeCodexCatalogSourceResolver>,
  probe: (catalogPath?: string) => Effect.Effect<T, E, R>,
) {
  const candidate = yield* source.candidate;
  const result = yield* probe(candidate);
  const hasNativeModels = (snapshot: T) =>
    snapshot.status === "ready" && snapshot.models.some((model) => !model.isCustom);
  if (hasNativeModels(result)) {
    yield* source.accept(candidate);
    return result;
  }

  const accepted = yield* source.accepted;
  if (accepted && accepted !== candidate) {
    const fallback = yield* probe(accepted);
    if (hasNativeModels(fallback)) return fallback;
  }
  return result;
});
