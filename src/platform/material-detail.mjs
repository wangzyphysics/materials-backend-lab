import path from "node:path";
import {
  curveTable,
  curvePoints,
} from "../domain/materials/batch-contribution.ts";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const number = (v) => (v == null ? null : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recordKeys = [
  "origin",
  "dataType",
  "phaseId",
  "conditionId",
  "acquisitionLabel",
  "acquiredAt",
  "instrument",
  "pressureMode",
  "temperatureMode",
  "sampleId",
  "formula",
  "pressureGPa",
  "temperatureK",
  "phaseLabel",
  "structureRecordId",
  "method",
  "source",
  "processing",
  "notes",
  "xQuantity",
  "xUnit",
  "yQuantity",
  "yUnit",
  "xColumn",
  "yColumn",
];
const pick = (object, keys) =>
  Object.fromEntries(
    keys.filter((k) => object?.[k] !== undefined).map((k) => [k, object[k]]),
  );
function reference(value) {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k, v]) =>
          ["file", "line", "field", "sha256", "association_basis"].includes(
            k,
          ) && ["string", "number"].includes(typeof v),
      )
      .map(([k, v]) => [k, k === "file" ? path.basename(v) : v]),
  );
}
function cellDto(s) {
  return {
    id: s.structure_id,
    role: s.role,
    lattice: s.geometry_json.lattice,
    sites: s.geometry_json.sites,
    volumeA3: Number(s.volume_a3),
    siteCount: s.nsites,
    composition: s.composition_json,
  };
}

/** Read-only scientific projection. A cell representation is never substituted for a calculation cell. */
export async function materialDetail(db, key, user) {
  if (typeof key !== "string" || key.length > 200 || !key.length)
    fail(404, "Record not found");
  if (key.startsWith("contribution_")) return contributionDetail(db, key, user);
  const matches = (
    await db.query(
      `SELECT m.*,p.source_label AS phase_label,p.assignment_basis FROM calypso_lab.materials m LEFT JOIN calypso_lab.phases p USING(phase_id)
 WHERE m.display_structure_id=$1 OR m.material_id=$1 OR EXISTS(SELECT 1 FROM calypso_lab.material_sources a WHERE a.material_id=m.material_id AND a.external_material_id=$1) LIMIT 2`,
      [key],
    )
  ).rows;
  if (matches.length > 1)
    fail(409, "Ambiguous source identifier; use an exact record ID");
  const m = matches[0];
  if (!m) fail(404, "Record not found");
  const structures = (
    await db.query(
      `SELECT * FROM calypso_lab.structures WHERE material_id=$1 ORDER BY CASE role WHEN 'display_unit_cell' THEN 0 WHEN 'relax_output' THEN 1 ELSE 2 END,structure_id`,
      [m.material_id],
    )
  ).rows;
  const tasks = (
    await db.query(
      `SELECT c.*,r.raw_energy_ev_cell,r.energy_definition,r.n_atoms_cell,r.volume_a3_cell,r.energy_structure_id,r.result_json,r.quality_flags_json,mt.settings_json,
 ARRAY(SELECT external_task_id FROM calypso_lab.calculation_sources a WHERE a.calculation_id=c.calculation_id ORDER BY external_task_id) AS external_ids,
 EXISTS(SELECT 1 FROM calypso_lab.property_choices pc WHERE pc.calculation_id=c.calculation_id) AS selected
 FROM calypso_lab.calculations c LEFT JOIN calypso_lab.calculation_results r USING(calculation_id) LEFT JOIN calypso_lab.methods mt USING(method_id)
 WHERE c.material_id=$1 ORDER BY c.type,c.calculation_id`,
      [m.material_id],
    )
  ).rows;
  const symmetry =
    tasks.find((t) => t.type === "symmetry" && t.selected) ??
    tasks.find((t) => t.type === "symmetry");
  const sym = symmetry?.result_json ?? {};
  const sources = (
    await db.query(
      `SELECT a.*,s.provenance_json AS source_provenance FROM calypso_lab.material_sources a JOIN calypso_lab.sources s USING(source_id) WHERE a.material_id=$1 ORDER BY a.source_id,a.external_material_id`,
      [m.material_id],
    )
  ).rows;
  const related = m.phase_id
    ? (
        await db.query(
          `SELECT m.material_id,m.display_structure_id,m.formula,m.pressure_gpa,p.source_label FROM calypso_lab.materials m JOIN calypso_lab.phases p USING(phase_id) WHERE m.phase_id=$1 ORDER BY m.pressure_gpa NULLS LAST,m.material_id LIMIT 201`,
          [m.phase_id],
        )
      ).rows
    : [];
  return {
    recordId: m.display_structure_id,
    materialId: m.material_id,
    formula: m.formula,
    phaseId: m.phase_id,
    phaseLabel: m.phase_label ?? null,
    spaceGroup: sym.symbol ?? null,
    spaceGroupNumber: sym.number ?? null,
    crystalSystem: sym.crystal_system ?? null,
    pressureGPa: number(m.pressure_gpa),
    pressureStatus: m.pressure_status,
    temperatureK: null,
    temperatureStatus: "unreported",
    provenance: "imported",
    dataType: "structure",
    origin: null,
    createdAt: iso(m.created_at),
    updatedAt: iso(m.updated_at),
    externalIds: sources.map((s) => s.external_material_id),
    cells: structures.map(cellDto),
    defaultCellId: m.display_structure_id,
    symmetry: {
      scope:
        "Source symmetry of the display representation; not reassigned to calculation cells.",
      pointGroup: sym.point_group ?? null,
      tolerance: sym.symprec ?? null,
      codeVersion: sym.codeversion ?? null,
    },
    calculations: tasks.map((t) => ({
      id: t.calculation_id,
      type: t.type,
      runState: t.run_state,
      validationState: t.validation_state,
      selected: t.selected,
      structureId: t.output_structure_id,
      externalIds: t.external_ids,
      settings: t.settings_json ?? {},
      energy:
        t.raw_energy_ev_cell == null
          ? null
          : {
              rawEvCell: Number(t.raw_energy_ev_cell),
              definition: t.energy_definition,
              structureId: t.energy_structure_id,
              nAtomsCell: Number(t.n_atoms_cell),
              volumeA3: Number(t.volume_a3_cell),
            },
      results: Object.fromEntries(
        Object.entries(t.result_json ?? {}).filter(
          ([k]) =>
            ![
              "structure",
              "cif",
              "forces",
              "stress",
              "outcar",
              "rep_fracpos",
              "rep_species",
              "wyckoff_symbols",
            ].includes(k),
        ),
      ),
      qualityFlags: t.quality_flags_json ?? [],
    })),
    sources: sources.map((s) => ({
      id: s.source_id,
      externalId: s.external_material_id,
      label: s.metadata_json?.source || s.source_id,
      license: s.metadata_json?.license || null,
      reference: reference(s.provenance_json),
      metadata: pick(s.metadata_json, [
        "formula_pretty",
        "chemsys",
        "last_updated",
        "experimental",
      ]),
    })),
    relatedRecords: related
      .slice(0, 200)
      .map((r) => ({
        recordId: r.display_structure_id,
        materialId: r.material_id,
        formula: r.formula,
        phaseLabel: r.source_label,
        pressureGPa: number(r.pressure_gpa),
      })),
    relatedHasMore: related.length > 200,
    phaseDefinition:
      "Grouped by an explicit source Phase ID within a composition. A phase label or a stored structure is not evidence of thermodynamic stability.",
    contribution: null,
  };
}

async function accessibleContribution(db, key, user) {
  const id = key.slice("contribution_".length);
  if (!uuid.test(id)) fail(404, "Record not found");
  const r = (
    await db.query(
      `SELECT r.*,b.owner_id,b.draft_json,b.review_status,b.submitted_at,b.updated_at,b.deleted_at,u.status AS owner_status,u.demo_account FROM calypso_platform.records r JOIN calypso_platform.batches b ON b.id=r.batch_id JOIN calypso_platform.users u ON u.id=b.owner_id WHERE r.id=$1`,
      [id],
    )
  ).rows[0];
  if (!r || r.deleted_at || r.owner_status === "deleted" || r.demo_account)
    fail(404, "Record not found");
  const published =
    r.review_status === "approved" &&
    r.draft_json.visibility === "public-after-review";
  const owner = r.owner_id === user?.id,
    reviewer = user?.role === "admin" && r.submitted_at;
  if (!published && !owner && !reviewer) fail(404, "Record not found");
  return { ...r, access: published ? "public" : owner ? "owner" : "reviewer" };
}
async function contributionDetail(db, key, user) {
  const r = await accessibleContribution(db, key, user),
    input = r.input_json;
  const file = (
    await db.query(
      "SELECT client_id,path,size,sha256,media_type,bytes FROM calypso_platform.files WHERE batch_id=$1 AND client_id=$2",
      [r.batch_id, input.fileId],
    )
  ).rows[0];
  const phase = r.draft_json.phases?.find((p) => p.id === input.phaseId);
  const records = (
    await db.query(
      `SELECT id,input_json FROM calypso_platform.records WHERE batch_id=$1 AND input_json->>'phaseId'=$2 ORDER BY id LIMIT 201`,
      [r.batch_id, input.phaseId ?? ""],
    )
  ).rows;
  let curve = null,
    curveError = null;
  if (file && ["raman", "xrd", "property"].includes(input.dataType)) {
    try {
      const table = curveTable(
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      );
      curve = {
        points: curvePoints(
          table,
          input.xColumn,
          input.yColumn,
          input.dataType === "property" ? 1 : 2,
        ),
        xQuantity: input.xQuantity,
        xUnit: input.xUnit,
        yQuantity: input.yQuantity,
        yUnit: input.yUnit,
      };
    } catch {
      curveError =
        "The original file cannot be represented as a numerical curve. Download it to inspect the source data.";
    }
  }
  return {
    recordId: key,
    materialId: "submission_" + r.id,
    formula: input.formula,
    phaseId: input.phaseId || null,
    phaseLabel: input.phaseLabel || null,
    spaceGroup: null,
    spaceGroupNumber: null,
    crystalSystem: null,
    pressureGPa:
      input.pressureMode === "reported" && input.pressureGPa !== ""
        ? Number(input.pressureGPa)
        : null,
    pressureStatus: input.pressureMode ?? "unreported",
    provenance: "contributed",
    dataType: input.dataType,
    origin: input.origin,
    createdAt: iso(r.submitted_at),
    updatedAt: iso(r.updated_at),
    externalIds: [],
    cells: [],
    defaultCellId: null,
    symmetry: null,
    calculations: [],
    sources: [],
    relatedRecords: records
      .slice(0, 200)
      .map((v) => ({
        recordId: "contribution_" + v.id,
        materialId: "submission_" + v.id,
        formula: v.input_json.formula,
        phaseLabel: v.input_json.phaseLabel || null,
        pressureGPa:
          v.input_json.pressureMode === "reported" &&
          v.input_json.pressureGPa !== ""
            ? Number(v.input_json.pressureGPa)
            : null,
      })),
    relatedHasMore: records.length > 200,
    phaseDefinition:
      "Contributor-assigned Phase ID within this upload batch. Review approval is not independent phase identification or a stability assessment.",
    temperatureK:
      input.temperatureMode === "reported" && input.temperatureK !== ""
        ? Number(input.temperatureK)
        : null,
    temperatureStatus: input.temperatureMode ?? "unreported",
    contribution: {
      batchId: r.batch_id,
      batchTitle: r.draft_json.title,
      access: r.access,
      reviewStatus: r.review_status,
      visibility: r.draft_json.visibility,
      identification: phase?.identification ?? "unassigned",
      evidence: phase?.evidence ?? "",
      record: pick(input, recordKeys),
      attribution: pick(r.draft_json.contributor, [
        "name",
        "institution",
        "researchGroup",
      ]),
      file: file
        ? {
            name: path.basename(file.path),
            size: Number(file.size),
            sha256: file.sha256,
          }
        : null,
      curve,
      curveError,
    },
  };
}

const determinant = ([a, b, c]) =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) -
  a[1] * (b[0] * c[2] - b[2] * c[0]) +
  a[2] * (b[0] * c[1] - b[1] * c[0]);
const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
const length = (a) => Math.sqrt(dot(a, a));
const angle = (a, b) =>
  (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / length(a) / length(b)))) *
    180) /
  Math.PI;
const fmt = (v) => Number(v.toFixed(12)).toString();
/** Generated exports describe the selected full cell, not a reconstructed source input. */
export function exportCell(cell, format, title = "CALYPSO selected structure") {
  if (format === "poscar") {
    if (
      cell.sites.some(
        (s) =>
          s.species.length !== 1 ||
          Math.abs(s.species[0].occupancy - 1) > 1e-10,
      )
    )
      fail(
        422,
        "POSCAR requires fully occupied, single-species sites. Use CIF or JSON to preserve occupancies.",
      );
    const elements = [
      ...new Set(cell.sites.map((s) => s.species[0].element)),
    ].sort();
    return [
      title.replace(/[\r\n]/g, " "),
      "1.0",
      ...cell.lattice.map((v) => v.map(fmt).join(" ")),
      elements.join(" "),
      elements
        .map(
          (el) => cell.sites.filter((s) => s.species[0].element === el).length,
        )
        .join(" "),
      "Direct",
      ...elements.flatMap((el) =>
        cell.sites
          .filter((s) => s.species[0].element === el)
          .map((s) => s.frac_coords.map(fmt).join(" ")),
      ),
      "",
    ].join("\n");
  }
  if (format === "csv")
    return [
      "site,element,occupancy,fractional_x,fractional_y,fractional_z",
      ...cell.sites.flatMap((s, i) =>
        s.species.map((sp) =>
          [i + 1, sp.element, sp.occupancy, ...s.frac_coords].join(","),
        ),
      ),
      "",
    ].join("\n");
  if (format === "cif") {
    // CIF metrics convention uses a right-handed basis; transform c and z together.
    const flip = determinant(cell.lattice) < 0,
      lattice = cell.lattice.map((v, i) =>
        v.map((x) => (flip && i === 2 ? -x : x)),
      );
    const [a, b, c] = lattice;
    return [
      "# CALYPSO generated full-cell export. No symmetry reduction performed.",
      "# P1 below is the export representation, not a new symmetry determination.",
      `# Structure record: ${cell.id}`,
      "data_calypso",
      `_cell_length_a ${fmt(length(a))}`,
      `_cell_length_b ${fmt(length(b))}`,
      `_cell_length_c ${fmt(length(c))}`,
      `_cell_angle_alpha ${fmt(angle(b, c))}`,
      `_cell_angle_beta ${fmt(angle(a, c))}`,
      `_cell_angle_gamma ${fmt(angle(a, b))}`,
      "_space_group_name_H-M_alt 'P 1'",
      "_space_group_IT_number 1",
      "loop_",
      "_space_group_symop_operation_xyz",
      "'x,y,z'",
      "loop_",
      "_atom_site_label",
      "_atom_site_type_symbol",
      "_atom_site_fract_x",
      "_atom_site_fract_y",
      "_atom_site_fract_z",
      "_atom_site_occupancy",
      ...cell.sites.flatMap((s, i) =>
        s.species.map((sp) =>
          [
            sp.element + (i + 1),
            sp.element,
            ...s.frac_coords.map((x, j) =>
              fmt(flip && j === 2 ? ((-x % 1) + 1) % 1 : x),
            ),
            fmt(sp.occupancy),
          ].join(" "),
        ),
      ),
      "",
    ].join("\n");
  }
  fail(400, "Unsupported structure format");
}
export async function detailDownload(db, key, user, params) {
  for (const k of params.keys())
    if (!["format", "cell"].includes(k) || params.getAll(k).length !== 1)
      fail(400, "Unsupported download parameter");
  const format = params.get("format") ?? "json",
    detail = await materialDetail(db, key, user);
  if (format === "original") {
    if (!detail.contribution) fail(404, "Original file not available");
    const r = await accessibleContribution(db, key, user),
      file = (
        await db.query(
          "SELECT path,bytes FROM calypso_platform.files WHERE batch_id=$1 AND client_id=$2",
          [r.batch_id, r.input_json.fileId],
        )
      ).rows[0];
    if (!file) fail(404, "Original file not available");
    return {
      bytes: file.bytes,
      type: "application/octet-stream",
      name: path.basename(file.path),
    };
  }
  if (format === "json") {
    const selected = params.get("cell") ?? detail.defaultCellId;
    if (selected && !detail.cells.some((c) => c.id === selected))
      fail(404, "Selected cell not available for this record");
    return {
      bytes: JSON.stringify(
        {
          schemaVersion: 1,
          exportKind: "calypso-record-detail",
          selectedCellId: selected,
          ...detail,
        },
        null,
        2,
      ),
      type: "application/json",
      name: detail.recordId + ".json",
    };
  }
  const id = params.get("cell") ?? detail.defaultCellId,
    cell = detail.cells.find((c) => c.id === id);
  if (!cell) fail(404, "Selected cell not available for this record");
  return {
    bytes: exportCell(cell, format, detail.formula + " | " + cell.id),
    type:
      format === "csv"
        ? "text/csv; charset=utf-8"
        : "text/plain; charset=utf-8",
    name: cell.id + (format === "poscar" ? ".vasp" : "." + format),
  };
}
