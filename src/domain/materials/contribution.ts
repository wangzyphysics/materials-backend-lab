import { z } from "zod";
import { normalizeSearch } from "./search.ts";

export const maximumStructureBytes = 5 * 1024 * 1024;
export type StructureFormat = "cif" | "poscar";
export type FileReview = {
  format: StructureFormat;
  checks: string[];
  warnings: string[];
};
const numeric = (value: string) =>
  value.trim() !== "" && Number.isFinite(Number(value));

/** Basic text-format checks only; this is not a crystallographic validator. */
export function reviewStructureFile(
  name: string,
  text: string,
  maximumBytes = maximumStructureBytes,
): FileReview {
  if (!text.trim()) throw new Error("The structure file is empty.");
  if (text.includes("\0"))
    throw new Error("Choose a plain-text CIF or POSCAR file.");
  if (new TextEncoder().encode(text).byteLength > maximumBytes)
    throw new Error(
      "Choose a structure file no larger than " +
        maximumBytes / (1024 * 1024) +
        " MiB.",
    );
  const warnings = [
    "Only basic format checks are performed. Structure consistency, scientific validity and calculation settings require review.",
  ];
  if (/\.cif$/i.test(name)) {
    const blocks = text.match(/^\s*data_\S+/gim) ?? [];
    if (!blocks.length) throw new Error("The CIF must contain a data_ block.");
    if (blocks.length !== 1)
      throw new Error("Choose a CIF with one structure data block per draft.");
    for (const parameter of [
      "length_a",
      "length_b",
      "length_c",
      "angle_alpha",
      "angle_beta",
      "angle_gamma",
    ]) {
      const value = new RegExp(
        `^\\s*_cell_${parameter}\\s+([^\\s#]+)`,
        "im",
      ).exec(text)?.[1];
      const number = value
        ? Number(value.replace(/^['\"]|['\"]$/g, "").replace(/\(\d+\)$/, ""))
        : NaN;
      if (
        !Number.isFinite(number) ||
        number <= 0 ||
        (parameter.startsWith("angle") && number >= 180)
      )
        throw new Error(`The CIF needs a valid _cell_${parameter} value.`);
    }
    const fractional = ["x", "y", "z"].every((axis) =>
      new RegExp(`^\\s*_atom_site_fract_${axis}\\b`, "im").test(text),
    );
    const cartesian = ["x", "y", "z"].every((axis) =>
      new RegExp(`^\\s*_atom_site_Cartn_${axis}\\b`, "im").test(text),
    );
    if (!fractional && !cartesian)
      throw new Error(
        "The CIF needs atom-site coordinate fields (fractional or Cartesian x, y, z).",
      );
    return {
      format: "cif",
      checks: [
        "CIF data block found",
        "Six cell parameters found",
        "Atom-site coordinate fields found",
      ],
      warnings,
    };
  }
  if (!/(?:^POSCAR$|\.poscar$|\.vasp$)/i.test(name))
    throw new Error(
      "Supported structure files: .cif, POSCAR, .poscar or .vasp.",
    );
  const lines = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines.length < 8)
    throw new Error(
      "The POSCAR is missing its cell or atomic-position section.",
    );
  const scale = lines[1].split(/\s+/);
  if (
    ![1, 3].includes(scale.length) ||
    !scale.every(numeric) ||
    scale.some((value) => Number(value) === 0) ||
    (scale.length === 3 && scale.some((value) => Number(value) < 0))
  )
    throw new Error(
      "The POSCAR needs a valid nonzero scale or three positive scale factors.",
    );
  const lattice = lines
    .slice(2, 5)
    .map((line) => line.split(/\s+/).slice(0, 3).map(Number));
  if (
    lattice.some(
      (vector) =>
        vector.length !== 3 || vector.some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error("The POSCAR needs three numeric lattice vectors.");
  const [a, b, c] = lattice;
  const determinant =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (!Number.isFinite(determinant) || determinant === 0)
    throw new Error(
      "The POSCAR lattice vectors must define a nonzero cell volume.",
    );
  let index = /^\d+(?:\s+\d+)*$/.test(lines[5]) ? 5 : 6;
  const counts = lines[index]?.split(/\s+/) ?? [];
  if (
    !counts.length ||
    !counts.every((count) => /^\d+$/.test(count)) ||
    counts.reduce((total, count) => total + Number(count), 0) <= 0
  )
    throw new Error(
      "The POSCAR needs nonnegative integer atom counts with a positive total.",
    );
  const total = counts.reduce((sum, count) => sum + Number(count), 0);
  index++;
  if (/^s/i.test(lines[index] ?? "")) index++;
  if (!/^[dck]/i.test(lines[index] ?? ""))
    throw new Error("The POSCAR needs Direct or Cartesian coordinate mode.");
  const positions = lines.slice(index + 1, index + 1 + total);
  if (
    positions.length !== total ||
    positions.some((line) => {
      const values = line.split(/\s+/).slice(0, 3);
      return values.length !== 3 || !values.every(numeric);
    })
  )
    throw new Error("The POSCAR positions must match its declared atom count.");
  return {
    format: "poscar",
    checks: [
      "Nonzero lattice cell found",
      "Atom counts and coordinate mode found",
      "Numeric position rows match the atom count",
    ],
    warnings,
  };
}
export const contributionSchema = z.object({
  contributorName: z
    .string()
    .trim()
    .min(1, "Enter the contributor name.")
    .max(120),
  email: z.string().trim().email("Enter a valid contact email."),
  formula: z
    .string()
    .trim()
    .min(1, "Enter the chemical formula.")
    .refine((value) => {
      try {
        normalizeSearch(value, "formula");
        return true;
      } catch {
        return false;
      }
    }, "Enter a valid chemical formula."),
  pressureGPa: z.number().finite("Enter a finite recorded pressure in GPa."),
  calculationMethod: z
    .string()
    .trim()
    .min(1, "Describe the calculation method.")
    .max(10000),
  source: z
    .string()
    .trim()
    .min(1, "Provide the data source or reference.")
    .max(4000),
  notes: z.string().trim().max(10000),
  permissionConfirmed: z.literal(true, {
    errorMap: () => ({
      message: "Confirm that you have permission to share this contribution.",
    }),
  }),
});
export type ContributionInput = z.infer<typeof contributionSchema>;
export function createContributionDraft(
  input: ContributionInput,
  structure: { name: string; text: string; sha256: string },
) {
  const metadata = contributionSchema.parse(input);
  const review = reviewStructureFile(structure.name, structure.text);
  return {
    schemaVersion: 1,
    status: "local-draft",
    metadata: {
      ...metadata,
      formula: normalizeSearch(metadata.formula, "formula"),
    },
    structure: {
      fileName: structure.name,
      format: review.format,
      sha256: structure.sha256,
      content: structure.text,
    },
    preflight: review,
  };
}
