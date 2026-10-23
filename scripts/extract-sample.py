#!/usr/bin/env python3
"""Copy 20 real records and their tasks, preserving original lines and checksums."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ["materials", "relax", "static", "symmetry", "synthesizability"]


def structure(value):
    if not isinstance(value, dict) or not value.get("sites"):
        return None
    return {"lattice": value["lattice"]["matrix"], "sites": [
        {"species": [{"element": s["element"], "occupancy": s.get("occu", 1)} for s in site["species"]],
         "frac_coords": site["abc"]} for site in value["sites"]]}


def final_structure(task):
    outputs = task.get("outputs") or {}
    result = structure(outputs.get("structure"))
    if result:
        return result, "outputs.structure"
    trajectory = task.get("trajectory") or {}
    if trajectory.get("lattices") and trajectory.get("fracpos") and trajectory.get("species"):
        points, species = trajectory["fracpos"][-1], trajectory["species"]
        if len(points) != len(species):
            raise ValueError("Final trajectory species/coordinates mismatch")
        return {"lattice": trajectory["lattices"][-1], "sites": [
            {"species": [{"element": element, "occupancy": 1}], "frac_coords": point}
            for element, point in zip(species, points)]}, "trajectory.final_step"
    return None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    static_ids = []
    with (source / "static.jsonl").open() as handle:
        for raw in handle:
            static_ids.append(json.loads(raw)["material_id"])
    if len(static_ids) != 9 or len(set(static_ids)) != 9:
        raise ValueError("Selection assumes the inspected dataset with 9 distinct static records; review selection if it changes")
    pressure_group, predictions, prediction_keys = {}, [], set()
    with (source / "materials.jsonl").open() as handle:
        for raw in handle:
            row = json.loads(raw)
            if row.get("phase_id") == "B2/n-mB24" and row.get("chemsys") == "H" and row.get("pressure") in [1, 15, 60]:
                pressure_group[row["pressure"]] = row["material_id"]
            if row["material_id"].startswith("caly-") and len(predictions) < 8:
                key = (row.get("chemsys"), row.get("pressure"))
                if key not in prediction_keys:
                    predictions.append(row["material_id"])
                    prediction_keys.add(key)
    if len(predictions) != 8 or set(pressure_group) != {1, 15, 60}:
        raise ValueError("Requested real sample coverage unavailable")
    selected = predictions + [pressure_group[p] for p in [1, 15, 60]] + static_ids
    if len(set(selected)) != 20:
        raise ValueError("Sample must contain 20 distinct source materials")
    wanted, records, files = set(selected), defaultdict(dict), {}
    destination = ROOT / "samples"
    (destination / "raw").mkdir(parents=True, exist_ok=True)
    for name in FILES:
        source_hash, copied_hash, count, refs = hashlib.sha256(), hashlib.sha256(), 0, []
        with (source / (name + ".jsonl")).open("rb") as handle, (destination / "raw" / (name + ".jsonl")).open("wb") as output:
            for line, raw in enumerate(handle, 1):
                source_hash.update(raw)
                row = json.loads(raw)
                if row.get("material_id") not in wanted:
                    continue
                mid = row["material_id"]
                if name in records[mid]:
                    raise ValueError(f"Multiple {name} records for {mid}; selection adapter needs an explicit rule")
                count += 1
                output.write(raw)
                copied_hash.update(raw)
                ref = {"file": name + ".jsonl", "original_line": line, "sample_line": count,
                       "row_sha256": hashlib.sha256(raw).hexdigest(), "sample_path": "samples/raw/" + name + ".jsonl"}
                records[mid][name] = {"raw": row, "source_ref": ref}
                refs.append(ref)
        files[name + ".jsonl"] = {"original_sha256": source_hash.hexdigest(), "selected_sha256": copied_hash.hexdigest(),
            "selected_records": count, "original_bytes": (source / (name + ".jsonl")).stat().st_size}
    materials = []
    for mid in selected:
        group = records[mid]
        metadata = group["materials"]["raw"]
        display = structure(group["symmetry"]["raw"].get("structure"))
        if not display:
            raise ValueError(f"No display unit cell for {mid}")
        tasks = []
        for name in FILES[1:]:
            if name not in group:
                continue
            task = group[name]
            raw = task["raw"]
            geometry, geometry_path = final_structure(raw) if name in ["relax", "static"] else (None, None)
            # Large trajectories stay in the copied raw file, with a verifiable row reference.
            result = raw.get("outputs") if name in ["relax", "static"] else {
                key: value for key, value in raw.items() if key not in ["material_id", "task_id", "path"]}
            tasks.append({"type": name, "external_task_id": raw["task_id"], "source_ref": task["source_ref"],
                "source_state": raw.get("state"), "source_status": raw.get("status"),
                "codeversion": raw.get("codeversion"), "inputs": raw.get("inputs") or {}, "result": result or {},
                "output_structure": geometry, "output_structure_field": geometry_path,
                "trajectory_ref": task["source_ref"] if raw.get("trajectory") else None})
        materials.append({"external_material_id": mid, "source_metadata": metadata,
            "source_ref": group["materials"]["source_ref"], "display_structure": display,
            "display_structure_ref": group["symmetry"]["source_ref"], "tasks": tasks})
    manifest = {"selection_version": 1, "source_directory": str(source), "files": files,
        "selected_external_material_ids": selected, "selection": {
            "predicted_structures": predictions, "existing_phase_pressure_points": pressure_group,
            "materials_with_static": static_ids}, "synthetic": False}
    bundle = {"format": "calypso-ingest", "schema_version": 1, "synthetic": False,
        "source": {"source_id": "legacy-calypso-results-0430", "manifest": manifest}, "materials": materials}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (destination / "ingest.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"materials": len(materials), "tasks": {name: files[name + ".jsonl"]["selected_records"] for name in FILES[1:]},
        "sample_directory": str(destination), "synthetic": False}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
