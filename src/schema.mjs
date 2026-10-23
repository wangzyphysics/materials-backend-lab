import { TYPES } from './model.mjs';
export function schemaSQL(backend) {
  const j=backend==='postgres'?'jsonb':'TEXT';
  const num=backend==='postgres'?'numeric':'REAL';
  const timestamp=backend==='postgres'?'timestamptz':'TEXT';
  const sql=`
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at ${timestamp} NOT NULL);
CREATE TABLE calculation_types(type TEXT PRIMARY KEY);
${TYPES.map(type=>`INSERT INTO calculation_types VALUES ('${type}');`).join('\n')}
CREATE TABLE sources(source_id TEXT PRIMARY KEY, provenance_json ${j} NOT NULL);
CREATE TABLE phases(
  phase_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), source_label TEXT NOT NULL,
  composition_key TEXT NOT NULL, composition_json ${j} NOT NULL, assignment_basis TEXT NOT NULL CHECK(assignment_basis='source_provided'),
  UNIQUE(source_id,source_label,composition_key)
);
CREATE TABLE materials(
  material_id TEXT PRIMARY KEY, phase_id TEXT REFERENCES phases(phase_id), pressure_gpa ${num},
  pressure_status TEXT NOT NULL CHECK(pressure_status IN ('reported','unreported')),
  formula TEXT NOT NULL, composition_key TEXT NOT NULL, composition_json ${j} NOT NULL,
  elements_json ${j} NOT NULL, chemsys TEXT NOT NULL, identity_key TEXT NOT NULL UNIQUE,
  identity_policy TEXT NOT NULL CHECK(identity_policy='exact_display_representation_v1'),
  display_structure_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL,
  CHECK((pressure_status='reported' AND pressure_gpa IS NOT NULL AND pressure_gpa>-1e308 AND pressure_gpa<1e308) OR (pressure_status='unreported' AND pressure_gpa IS NULL))
  ${backend==='postgres'?'':', FOREIGN KEY(material_id,display_structure_id) REFERENCES structures(material_id,structure_id) DEFERRABLE INITIALLY DEFERRED'}
);
CREATE TABLE structures(
  structure_id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(material_id),
  role TEXT NOT NULL CHECK(role IN ('display_unit_cell','relax_output','static_output')),
  geometry_json ${j} NOT NULL, structure_hash TEXT NOT NULL CHECK(length(structure_hash)=64),
  nsites INTEGER NOT NULL CHECK(nsites>0), volume_a3 DOUBLE PRECISION NOT NULL CHECK(volume_a3>0 AND volume_a3<1e308),
  composition_key TEXT NOT NULL, composition_json ${j} NOT NULL, provenance_json ${j} NOT NULL,
  UNIQUE(material_id,structure_id), UNIQUE(material_id,role,structure_hash)
);
${backend==='postgres'?'ALTER TABLE materials ADD FOREIGN KEY(material_id,display_structure_id) REFERENCES structures(material_id,structure_id) DEFERRABLE INITIALLY DEFERRED;':''}
CREATE TABLE material_sources(
  alias_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), external_material_id TEXT NOT NULL,
  material_id TEXT NOT NULL REFERENCES materials(material_id), metadata_json ${j} NOT NULL, provenance_json ${j} NOT NULL,
  UNIQUE(source_id,external_material_id)
);
CREATE TABLE methods(
  method_id TEXT PRIMARY KEY, settings_hash TEXT NOT NULL UNIQUE, settings_json ${j} NOT NULL,
  compatibility_state TEXT NOT NULL CHECK(compatibility_state='unverified')
);
CREATE TABLE calculations(
  calculation_id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(material_id),
  type TEXT NOT NULL REFERENCES calculation_types(type), method_id TEXT NOT NULL REFERENCES methods(method_id),
  output_structure_id TEXT, run_state TEXT NOT NULL CHECK(run_state IN ('successful','failed','running','unverified')),
  validation_state TEXT NOT NULL CHECK(validation_state='source_provided'), inputs_json ${j} NOT NULL,
  provenance_json ${j} NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64), created_at ${timestamp} NOT NULL,
  UNIQUE(material_id,calculation_id),
  FOREIGN KEY(material_id,output_structure_id) REFERENCES structures(material_id,structure_id)
);
CREATE TABLE calculation_results(
  calculation_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, energy_structure_id TEXT,
  raw_energy_ev_cell DOUBLE PRECISION, energy_definition TEXT NOT NULL CHECK(energy_definition='unverified'),
  n_atoms_cell INTEGER, volume_a3_cell DOUBLE PRECISION, result_json ${j} NOT NULL, quality_flags_json ${j} NOT NULL,
  FOREIGN KEY(material_id,calculation_id) REFERENCES calculations(material_id,calculation_id),
  FOREIGN KEY(material_id,energy_structure_id) REFERENCES structures(material_id,structure_id),
  CHECK((raw_energy_ev_cell IS NULL AND n_atoms_cell IS NULL AND volume_a3_cell IS NULL AND energy_structure_id IS NULL)
    OR(raw_energy_ev_cell IS NOT NULL AND raw_energy_ev_cell>-1e308 AND raw_energy_ev_cell<1e308
       AND n_atoms_cell IS NOT NULL AND n_atoms_cell>0 AND volume_a3_cell IS NOT NULL AND volume_a3_cell>0
       AND volume_a3_cell<1e308 AND energy_structure_id IS NOT NULL))
);
CREATE TABLE calculation_sources(
  alias_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), external_task_id TEXT NOT NULL,
  calculation_id TEXT NOT NULL REFERENCES calculations(calculation_id), provenance_json ${j} NOT NULL,
  UNIQUE(source_id,external_task_id)
);
CREATE TABLE property_choices(
  choice_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, property_key TEXT NOT NULL REFERENCES calculation_types(type),
  scope_key TEXT NOT NULL REFERENCES methods(method_id), calculation_id TEXT NOT NULL, updated_at ${timestamp} NOT NULL,
  FOREIGN KEY(material_id,calculation_id) REFERENCES calculations(material_id,calculation_id),
  UNIQUE(material_id,property_key,scope_key)
);
CREATE TABLE import_receipts(
  import_id TEXT PRIMARY KEY, package_hash TEXT NOT NULL UNIQUE, receipt_json ${j} NOT NULL,
  provenance_json ${j} NOT NULL, created_at ${timestamp} NOT NULL
);
CREATE TABLE analyses(
  analysis_id TEXT PRIMARY KEY, family_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  type TEXT NOT NULL CHECK(type IN ('enthalpy_curve','convex_hull')), conditions_json ${j} NOT NULL,
  comparison_scope TEXT NOT NULL, algorithm_version TEXT NOT NULL, input_hash TEXT NOT NULL,
  result_json ${j} NOT NULL, created_at ${timestamp} NOT NULL, UNIQUE(family_id,version)
);
CREATE TABLE analysis_inputs(
  input_id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES analyses(analysis_id), material_id TEXT NOT NULL,
  calculation_id TEXT NOT NULL, snapshot_json ${j} NOT NULL,
  FOREIGN KEY(material_id,calculation_id) REFERENCES calculations(material_id,calculation_id),
  UNIQUE(analysis_id,calculation_id)
);
CREATE INDEX materials_phase_pressure ON materials(phase_id,pressure_gpa,material_id);
CREATE INDEX materials_composition_pressure ON materials(composition_key,pressure_gpa,material_id);
CREATE INDEX materials_system_pressure ON materials(chemsys,pressure_gpa,material_id);
CREATE INDEX calculations_material_type ON calculations(material_id,type);
CREATE INDEX structures_material_role ON structures(material_id,role);
CREATE INDEX analysis_inputs_calculation ON analysis_inputs(calculation_id);
`;
  if (backend==='postgres') return sql+`
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable scientific record: add a new record/revision'; END $$;
${['structures','methods','calculations','calculation_results','analyses','analysis_inputs','material_sources','calculation_sources'].map(table=>
  `CREATE TRIGGER immutable_${table} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION immutable_record();`).join('\n')}
CREATE FUNCTION guard_material() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.phase_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM phases WHERE phase_id=NEW.phase_id AND composition_key=NEW.composition_key)
    THEN RAISE EXCEPTION 'Phase composition mismatch'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.pressure_gpa,NEW.pressure_status,NEW.composition_key,NEW.identity_key,NEW.display_structure_id,NEW.formula,NEW.composition_json,NEW.elements_json,NEW.chemsys)
    IS DISTINCT FROM ROW(OLD.pressure_gpa,OLD.pressure_status,OLD.composition_key,OLD.identity_key,OLD.display_structure_id,OLD.formula,OLD.composition_json,OLD.elements_json,OLD.chemsys)
    THEN RAISE EXCEPTION 'Material identity cannot be overwritten'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER material_guard BEFORE INSERT OR UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION guard_material();
CREATE FUNCTION guard_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.energy_structure_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM structures s
    WHERE s.structure_id=NEW.energy_structure_id AND s.material_id=NEW.material_id AND s.nsites=NEW.n_atoms_cell
      AND abs(s.volume_a3-NEW.volume_a3_cell)<=GREATEST(1e-6,s.volume_a3*1e-5))
    THEN RAISE EXCEPTION 'Energy must reference its actual calculation cell'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER result_guard BEFORE INSERT ON calculation_results FOR EACH ROW EXECUTE FUNCTION guard_result();
CREATE FUNCTION guard_choice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM calculations c JOIN calculation_results r USING(calculation_id)
    WHERE c.calculation_id=NEW.calculation_id AND c.material_id=NEW.material_id AND c.type=NEW.property_key AND c.method_id=NEW.scope_key)
    THEN RAISE EXCEPTION 'Property selection ownership/type/method mismatch'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER choice_guard BEFORE INSERT OR UPDATE ON property_choices FOR EACH ROW EXECUTE FUNCTION guard_choice();
`;
  return sql+`
${['structures','methods','calculations','calculation_results','analyses','analysis_inputs','material_sources','calculation_sources'].flatMap(table=>['UPDATE','DELETE'].map(action=>
  `CREATE TRIGGER immutable_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable scientific record'); END;`)).join('\n')}
CREATE TRIGGER material_phase_insert BEFORE INSERT ON materials WHEN NEW.phase_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM phases WHERE phase_id=NEW.phase_id AND composition_key=NEW.composition_key)
  BEGIN SELECT RAISE(ABORT,'Phase composition mismatch'); END;
CREATE TRIGGER material_identity_update BEFORE UPDATE ON materials WHEN
  NEW.pressure_gpa IS NOT OLD.pressure_gpa OR NEW.pressure_status IS NOT OLD.pressure_status OR NEW.composition_key IS NOT OLD.composition_key
  OR NEW.identity_key IS NOT OLD.identity_key OR NEW.display_structure_id IS NOT OLD.display_structure_id
  OR NEW.formula IS NOT OLD.formula OR NEW.composition_json IS NOT OLD.composition_json OR NEW.elements_json IS NOT OLD.elements_json OR NEW.chemsys IS NOT OLD.chemsys
  OR (NEW.phase_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM phases WHERE phase_id=NEW.phase_id AND composition_key=NEW.composition_key))
  BEGIN SELECT RAISE(ABORT,'Material identity/phase mismatch'); END;
CREATE TRIGGER result_guard BEFORE INSERT ON calculation_results WHEN NEW.energy_structure_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM structures s WHERE s.structure_id=NEW.energy_structure_id AND s.material_id=NEW.material_id AND s.nsites=NEW.n_atoms_cell
  AND abs(s.volume_a3-NEW.volume_a3_cell)<=MAX(1e-6,s.volume_a3*1e-5))
  BEGIN SELECT RAISE(ABORT,'Energy must reference its actual calculation cell'); END;
${['INSERT','UPDATE'].map(action=>`CREATE TRIGGER choice_guard_${action} BEFORE ${action} ON property_choices WHEN NOT EXISTS(
  SELECT 1 FROM calculations c JOIN calculation_results r USING(calculation_id) WHERE c.calculation_id=NEW.calculation_id
  AND c.material_id=NEW.material_id AND c.type=NEW.property_key AND c.method_id=NEW.scope_key)
  BEGIN SELECT RAISE(ABORT,'Property selection ownership/type/method mismatch'); END;`).join('\n')}
`;
}
