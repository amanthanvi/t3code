import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration047 from "./047_ProjectionThreadForks.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionThreadForks", (it) => {
  it.effect("adds fork lineage and side-chat columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "fork_json"));
      const sideChat = columns.find((column) => column.name === "side_chat");
      assert.equal(sideChat?.notnull, 1);
      assert.equal(sideChat?.dflt_value, "0");
    }),
  );

  it.effect("is a no-op when applied twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* Migration047;
      yield* Migration047;

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.equal(columns.filter((column) => column.name === "fork_json").length, 1);
      assert.equal(columns.filter((column) => column.name === "side_chat").length, 1);
    }),
  );
});
