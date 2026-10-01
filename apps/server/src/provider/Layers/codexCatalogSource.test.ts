// @effect-diagnostics nodeBuiltinImport:off - temporary catalog fixtures use native filesystem operations.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { makeCodexCatalogSourceResolver, probeCodexCatalogSource } from "./codexCatalogSource.ts";
import { codexAppServerArgs, codexSessionAppServerArgs } from "./codexLaunchArgs.ts";

const write = (filePath: string, contents: string) =>
  Effect.promise(() => NodeFSP.writeFile(filePath, contents));
const encodeCatalogPath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

describe("Codex catalog source", () => {
  it.effect("reads a rotated relative catalog path with spaces for each fresh spawn", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex catalog source ")),
      );
      return yield* Effect.gen(function* () {
        const source = NodePath.join(home, "cpamc config.toml");
        const catalogDir = NodePath.join(home, "catalog files");
        yield* Effect.promise(() => NodeFSP.mkdir(catalogDir));
        const first = NodePath.join(catalogDir, "first hash.json");
        const second = NodePath.join(catalogDir, "second hash.json");
        yield* write(first, '{"models":[{"slug":"first"}]}\n');
        yield* write(second, '{"models":[{"slug":"second"}]}\n');
        yield* write(source, 'model_catalog_json = "catalog files/first hash.json"\n');
        const sourceResolver = makeCodexCatalogSourceResolver("cpamc config.toml", home);

        assert.equal(yield* sourceResolver.accepted, undefined);
        assert.equal(yield* sourceResolver.candidate, first);
        assert.equal(yield* sourceResolver.accepted, undefined);
        yield* sourceResolver.accept(first);
        const originalArgs = codexSessionAppServerArgs(undefined, '-c model="gpt-6-astra"', first);
        yield* write(source, 'model_catalog_json = "catalog files/second hash.json"\n');
        assert.equal(yield* sourceResolver.candidate, second);
        assert.equal(yield* sourceResolver.accepted, first);
        yield* sourceResolver.accept(second);
        assert.equal(yield* sourceResolver.accepted, second);
        assert.deepEqual(originalArgs.slice(-2), [
          "-c",
          `model_catalog_json=${encodeCatalogPath(first)}`,
        ]);
        assert.deepEqual(codexAppServerArgs("", second).slice(-2), [
          "-c",
          `model_catalog_json=${encodeCatalogPath(second)}`,
        ]);

        yield* write(source, "model_catalog_json = [\n");
        assert.equal(yield* sourceResolver.candidate, second);
        yield* write(source, 'model_catalog_json = "catalog files/first hash.json"\n');
        yield* write(first, "{bad json");
        assert.equal(yield* sourceResolver.candidate, second);
        yield* Effect.promise(() => NodeFSP.rm(second));
        assert.equal(yield* sourceResolver.candidate, undefined);
        assert.equal(yield* sourceResolver.accepted, undefined);
      }).pipe(
        Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("keeps explicit launch arguments unchanged without a source", () =>
    Effect.gen(function* () {
      assert.equal(yield* makeCodexCatalogSourceResolver("").candidate, undefined);
      assert.deepEqual(
        codexSessionAppServerArgs(undefined, '-c model_catalog_json="manual.json"'),
        ["app-server", "-c", "model_catalog_json=manual.json"],
      );
    }),
  );

  it.effect("keeps the accepted catalog and published models when a candidate probe fails", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex catalog probe ")),
      );
      return yield* Effect.gen(function* () {
        const first = NodePath.join(home, "first.json");
        const second = NodePath.join(home, "second.json");
        const sourceFile = NodePath.join(home, "cpamc.config.toml");
        yield* write(first, '{"models":[{"slug":"first"}]}');
        yield* write(second, '{"models":[{"slug":"second"}]}');
        yield* write(sourceFile, 'model_catalog_json = "first.json"\n');
        const source = makeCodexCatalogSourceResolver(sourceFile);
        const probe = (catalogPath?: string) =>
          Effect.succeed({
            status: catalogPath === second ? "error" : "ready",
            models: catalogPath === second ? [] : [{ slug: "first", isCustom: false }],
          });
        const initial = yield* probeCodexCatalogSource(source, probe);
        assert.deepEqual(initial.models, [{ slug: "first", isCustom: false }]);
        assert.equal(yield* source.accepted, first);

        yield* write(sourceFile, 'model_catalog_json = "second.json"\n');
        const attempts: Array<string | undefined> = [];
        const failedCandidate = yield* probeCodexCatalogSource(source, (catalogPath) => {
          attempts.push(catalogPath);
          return probe(catalogPath);
        });
        assert.deepEqual(attempts, [second, first]);
        assert.deepEqual(failedCandidate.models, initial.models);
        assert.equal(yield* source.accepted, first);

        const promoted = yield* probeCodexCatalogSource(source, (catalogPath) =>
          Effect.succeed({
            status: "ready",
            models: [{ slug: catalogPath === second ? "second" : "first", isCustom: false }],
          }),
        );
        assert.deepEqual(promoted.models, [{ slug: "second", isCustom: false }]);
        assert.equal(yield* source.accepted, second);
      }).pipe(
        Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
      );
    }),
  );
});
