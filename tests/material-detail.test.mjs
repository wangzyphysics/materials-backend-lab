import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  platformPool,
  migrate,
  transaction,
} from "../src/platform/database.mjs";
import { createPlatformServer, createUser } from "../src/platform/server.mjs";
import {
  materialDetail,
  detailDownload,
  exportCell,
} from "../src/platform/material-detail.mjs";
import { readStatistics } from "../src/platform/statistics.mjs";
import { emptyProfile } from "../src/domain/accounts/model.ts";
import {
  newBatch,
  newPhase,
  newCondition,
  makeDraftFile,
  defaultRecord,
  batchSchema,
} from "../src/domain/materials/batch-contribution.ts";
import { saveContribution } from "../src/platform/contributions.mjs";

test("structure exports retain lattice, full-cell positions and occupancies without inferring symmetry", () => {
  const cell = {
    id: "test",
    lattice: [
      [2, 0, 0],
      [0, 3, 0],
      [0, 0, -4],
    ],
    sites: [
      {
        species: [{ element: "O", occupancy: 1 }],
        frac_coords: [0.1, 0.2, 0.3],
      },
      {
        species: [{ element: "Fe", occupancy: 1 }],
        frac_coords: [0.5, 0.6, 0.7],
      },
    ],
  };
  const poscar = exportCell(cell, "poscar").split("\n");
  assert.equal(poscar[4], "0 0 -4");
  assert.equal(poscar[5], "Fe O");
  assert.equal(poscar[8], "0.5 0.6 0.7");
  const cif = exportCell(cell, "cif");
  assert.match(cif, /not a new symmetry determination/);
  assert.match(cif, /O1 O 0.1 0.2 0.7 1/);
  assert.match(cif, /_cell_length_c 4/);
  const disorder = {
    ...cell,
    sites: [
      {
        species: [
          { element: "Fe", occupancy: 0.5 },
          { element: "O", occupancy: 0.5 },
        ],
        frac_coords: [0, 0, 0],
      },
    ],
  };
  assert.throws(
    () => exportCell(disorder, "poscar"),
    (e) => e.status === 422,
  );
  assert.match(exportCell(disorder, "cif"), /Fe1 Fe 0 0 0 0.5/);
  assert.match(exportCell(disorder, "csv"), /1,O,0.5,0,0,0/);
  assert.throws(
    () => exportCell(cell, "unsupported"),
    (e) => e.status === 400,
  );
});

test("PostgreSQL details: exact records, calculation cells, visibility and authorized exports", async (t) => {
  const pool = await platformPool();
  await migrate(pool);
  const ids = [],
    batches = [];
  let server;
  try {
    const all = (
      await pool.query("SELECT display_structure_id FROM calypso_lab.materials")
    ).rows;
    assert.equal(all.length, 20);
    for (const row of all) {
      const d = await readStatistics(pool, (db) =>
        materialDetail(db, row.display_structure_id, { id: "read-only" }),
      );
      assert.equal(d.recordId, row.display_structure_id);
      assert.equal(
        d.cells.find((c) => c.id === d.defaultCellId).role,
        "display_unit_cell",
      );
      assert.ok(!JSON.stringify(d).includes("password_hash"));
      for (const c of d.calculations.filter((c) => c.energy)) {
        const cell = d.cells.find((s) => s.id === c.energy.structureId);
        assert.equal(c.energy.nAtomsCell, cell.siteCount);
        assert.ok(Math.abs(c.energy.volumeA3 - cell.volumeA3) < 1e-5);
      }
    }
    const d = await readStatistics(pool, (db) =>
      materialDetail(db, "caly-259513", { id: "read-only" }),
    );
    assert.equal(d.cells[0].siteCount, 30);
    assert.equal(d.cells.find((c) => c.role === "relax_output").siteCount, 15);
    assert.equal(d.calculations.find((c) => c.energy).energy.nAtomsCell, 15);
    assert.equal(d.spaceGroup, "Cm");
    const grouped = (
      await pool.query(
        "SELECT phase_id FROM calypso_lab.materials WHERE phase_id IS NOT NULL GROUP BY phase_id HAVING count(*)>1 LIMIT 1",
      )
    ).rows[0];
    const member = (
      await pool.query(
        "SELECT display_structure_id FROM calypso_lab.materials WHERE phase_id=$1 LIMIT 1",
        [grouped.phase_id],
      )
    ).rows[0];
    const related = await materialDetail(pool, member.display_structure_id, {});
    assert.ok(related.relatedRecords.length > 1);
    assert.match(related.phaseDefinition, /not evidence/);
    await assert.rejects(
      detailDownload(
        pool,
        d.recordId,
        {},
        new URLSearchParams("format=cif&cell=another-material-cell"),
      ),
      (e) => e.status === 404,
    );
    await assert.rejects(
      materialDetail(pool, "' OR 1=1 --", {}),
      (e) => e.status === 404,
    );
    const password = "Disposable detail test password 57",
      suffix = randomUUID().slice(0, 8),
      users = [];
    for (const [i, role] of ["member", "member", "admin"].entries()) {
      const user = await createUser(
        pool,
        {
          username: `qa.detail.${suffix}.${i}`,
          email: `qa.detail.${suffix}.${i}@example.test`,
          password,
          profile: {
            ...emptyProfile("Detail QA"),
            institution: "QA institution",
            researchGroup: "QA group",
            careerStage: "researcher",
          },
        },
        { role, test: true },
      );
      ids.push(user.id);
      users.push(user);
    }
    server = await createPlatformServer(pool);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + server.address().port;
    const client = () => ({
      cookie: "",
      csrf: "",
      async request(endpoint, method = "GET", body) {
        const res = await fetch(base + endpoint, {
          method,
          headers: {
            Origin: "http://127.0.0.1:5173",
            Cookie: this.cookie,
            ...(method === "GET"
              ? {}
              : {
                  "X-CSRF-Token": this.csrf,
                  "Content-Type": "application/json",
                }),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (res.headers.get("set-cookie"))
          this.cookie = res.headers.get("set-cookie").split(";")[0];
        const data = res.headers.get("content-type")?.includes("json")
          ? await res.json()
          : await res.text();
        if (data?.csrfToken) this.csrf = data.csrfToken;
        return { status: res.status, data };
      },
    });
    const anonymous = client(),
      clients = [client(), client(), client()];
    await t.test(
      "HTTP detail and downloads require sign-in; IDs resolve without leaking unknown records",
      async () => {
        assert.equal(
          (await anonymous.request("/api/materials/records/" + d.recordId))
            .status,
          401,
        );
        assert.equal(
          (
            await anonymous.request(
              "/api/materials/records/" + d.recordId + "/download?format=json",
            )
          ).status,
          401,
        );
        for (const [i, c] of clients.entries()) {
          await c.request("/api/identity/session");
          assert.equal(
            (
              await c.request("/api/identity/password/sign-in", "POST", {
                identity: users[i].username,
                password,
              })
            ).status,
            200,
          );
        }
        assert.equal(
          (await clients[0].request("/api/materials/records/caly-259513")).data
            .recordId,
          d.recordId,
        );
        assert.equal(
          (await clients[0].request("/api/materials/records/missing")).status,
          404,
        );
        const exported = await clients[0].request(
          "/api/materials/records/" +
            d.recordId +
            "/download?format=poscar&cell=" +
            d.cells[1].id,
        );
        assert.equal(exported.status, 200);
        assert.equal(
          exported.data
            .split("\n")[6]
            .split(" ")
            .map(Number)
            .reduce((a, b) => a + b),
          15,
        );
      },
    );
    const batch = newBatch(),
      phase = { ...newPhase(), formula: "FeO" },
      condition = {
        ...newCondition(phase.id),
        pressureMode: "reported",
        pressureGPa: "50",
        temperatureMode: "reported",
        temperatureK: "300",
      };
    const file = await makeDraftFile(
      "raman.csv",
      new TextEncoder().encode("shift,intensity\n200,5\n100,3\n300,1\n"),
    );
    const record = {
      ...defaultRecord(file.id, 1, "experimental", "raman"),
      phaseId: phase.id,
      conditionId: condition.id,
      method: "Disposable QA source",
      source: "Synthetic QA; removed after verification",
    };
    const draft = batchSchema.parse({
      ...batch,
      title: "Detail QA",
      phases: [phase],
      conditions: [condition],
      files: [file],
      records: [record],
      visibility: "private",
      permissionConfirmed: true,
      contributor: {
        ...batch.contributor,
        name: "QA scientist",
        email: "private@example.test",
      },
    });
    await saveContribution(pool, users[0], draft, null);
    batches.push(draft.id);
    const rid =
      "contribution_" +
      (
        await pool.query(
          "SELECT id FROM calypso_platform.records WHERE batch_id=$1",
          [draft.id],
        )
      ).rows[0].id;
    await t.test(
      "private draft and original files are owner-only, with source curve order preserved",
      async () => {
        const owner = await clients[0].request("/api/materials/records/" + rid);
        assert.equal(owner.status, 200);
        assert.deepEqual(owner.data.contribution.curve.points, [
          [200, 5],
          [100, 3],
          [300, 1],
        ]);
        assert.equal(owner.data.pressureGPa, 50);
        assert.equal(owner.data.cells.length, 0);
        assert.ok(!JSON.stringify(owner.data).includes("private@example.test"));
        for (const c of [clients[1], clients[2]]) {
          assert.equal(
            (await c.request("/api/materials/records/" + rid)).status,
            404,
          );
          assert.equal(
            (
              await c.request(
                "/api/materials/records/" + rid + "/download?format=original",
              )
            ).status,
            404,
          );
        }
      },
    );
    await t.test(
      "submitted private data permit reviewer access, never ordinary-user access; public approval enables read/download",
      async () => {
        await pool.query(
          "UPDATE calypso_platform.batches SET review_status='pending',submitted_at=now() WHERE id=$1",
          [draft.id],
        );
        assert.equal(
          (await clients[2].request("/api/materials/records/" + rid)).status,
          200,
        );
        assert.equal(
          (await clients[1].request("/api/materials/records/" + rid)).status,
          404,
        );
        await pool.query(
          "UPDATE calypso_platform.batches SET review_status='approved',draft_json=jsonb_set(draft_json,'{visibility}','\"public-after-review\"') WHERE id=$1",
          [draft.id],
        );
        assert.equal(
          (await clients[1].request("/api/materials/records/" + rid)).status,
          200,
        );
        assert.match(
          (
            await clients[1].request(
              "/api/materials/records/" + rid + "/download?format=original",
            )
          ).data,
          /200,5/,
        );
        await pool.query(
          "UPDATE calypso_platform.batches SET deleted_at=now() WHERE id=$1",
          [draft.id],
        );
        assert.equal(
          (await clients[1].request("/api/materials/records/" + rid)).status,
          404,
        );
        assert.equal(
          (
            await clients[0].request(
              "/api/materials/records/" + rid + "/download?format=original",
            )
          ).status,
          404,
        );
      },
    );
  } finally {
    if (server)
      await new Promise((r) => {
        server.close(r);
        server.closeIdleConnections();
      });
    if (ids.length)
      await transaction(pool, async (db) => {
        for (const table of [
          "batch_events",
          "records",
          "files",
          "contribution_conditions",
          "contribution_phases",
        ])
          await db.query(
            `DELETE FROM calypso_platform.${table} WHERE batch_id IN(SELECT id FROM calypso_platform.batches WHERE owner_id=ANY($1::uuid[]))`,
            [ids],
          );
        await db.query(
          "DELETE FROM calypso_platform.batches WHERE owner_id=ANY($1::uuid[])",
          [ids],
        );
        for (const table of ["sessions", "password_credentials"])
          await db.query(
            `DELETE FROM calypso_platform.${table} WHERE user_id=ANY($1::uuid[])`,
            [ids],
          );
        await db.query(
          "DELETE FROM calypso_platform.users WHERE id=ANY($1::uuid[])",
          [ids],
        );
      });
    await pool.end();
  }
});
