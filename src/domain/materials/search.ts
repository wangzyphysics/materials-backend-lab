import { elementSymbols } from "./elements.ts";

export const searchModes = [
  "any",
  "formula",
  "elements",
  "system",
  "id",
  "record",
  "phase",
] as const;
export type SearchMode = (typeof searchModes)[number];
export const crystalSystems = [
  "triclinic",
  "monoclinic",
  "orthorhombic",
  "tetragonal",
  "trigonal",
  "hexagonal",
  "cubic",
] as const;
export type FilterDraft = {
  excludeElements: string;
  pressureMin: string;
  pressureMax: string;
  crystalSystem: string;
  spaceGroup: string;
  elementsMin: string;
  elementsMax: string;
  provenance: string;
  origin: string;
  dataType: string;
  pressureAvailability: string;
  sort: string;
};
export const resultFilterOptions = {
  provenance: { imported: "Imported dataset", contributed: "Reviewed contributions" },
  origin: { theoretical: "Theoretical", experimental: "Experimental", unreported: "Origin not supplied" },
  dataType: { structure: "Crystal structures", raman: "Raman spectra", xrd: "X-ray diffraction", property: "Physical properties", attachment: "Supporting files" },
  pressureAvailability: { reported: "Pressure reported", missing: "Pressure not supplied" },
  sort: { created_desc: "Added to database", formula_asc: "Formula A–Z", pressure_asc: "Pressure: low to high", pressure_desc: "Pressure: high to low", space_group_asc: "Space group" },
} as const;
export type SearchFilters = {
  excludeElements?: string;
  pressureMin?: number;
  pressureMax?: number;
  crystalSystem?: string;
  spaceGroup?: string;
  elementsMin?: number;
  elementsMax?: number;
  provenance?: string;
  origin?: string;
  dataType?: string;
  pressureAvailability?: string;
  sort?: string;
};
export const emptyFilters: FilterDraft = {
  excludeElements: "",
  pressureMin: "",
  pressureMax: "",
  crystalSystem: "",
  spaceGroup: "",
  elementsMin: "",
  elementsMax: "",
  provenance: "",
  origin: "",
  dataType: "",
  pressureAvailability: "",
  sort: "",
};
export function isSearchMode(value: string | null): value is SearchMode {
  return searchModes.some((mode) => mode === value);
}
function asciiDigits(query: string) {
  return query
    .trim()
    .replace(/[₀-₉]/g, (char) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(char)));
}
export function parseElements(query: string) {
  const symbols = [
    ...new Set(
      query
        .trim()
        .split(/[\s,;\-]+/)
        .filter(Boolean),
    ),
  ];
  if (!symbols.every((symbol) => elementSymbols.has(symbol)))
    throw new Error(
      "Use valid, case-sensitive element symbols, such as Fe, O or Si.",
    );
  return symbols;
}
function validateFormula(formula: string): string[] {
  const tokens = formula.match(/[A-Z][a-z]?|\d+(?:\.\d+)?|[()]/g) ?? [];
  if (tokens.join("") !== formula || !tokens.length)
    throw new Error(
      "Use a chemical formula with standard element symbols, such as Fe2O3.",
    );
  let index = 0;
  const symbols: string[] = [];
  function group(nested: boolean) {
    let entries = 0;
    while (index < tokens.length && tokens[index] !== ")") {
      const token = tokens[index++];
      if (token === "(") group(true);
      else if (elementSymbols.has(token)) symbols.push(token);
      else throw new Error("Use valid element symbols in your formula.");
      entries++;
      if (/^\d/.test(tokens[index] ?? "")) {
        if (!(Number(tokens[index++]) > 0))
          throw new Error("Formula amounts must be positive.");
      }
    }
    if (!entries) throw new Error("A formula group cannot be empty.");
    if (nested) {
      if (tokens[index++] !== ")")
        throw new Error("Check the parentheses in your formula.");
    }
  }
  group(false);
  if (index !== tokens.length)
    throw new Error("Check the parentheses in your formula.");
  return [...new Set(symbols)];
}
export function normalizeSearch(query: string, mode: SearchMode) {
  const normalized = asciiDigits(query);
  if (!normalized || normalized.length > 200)
    throw new Error("Enter a search of 1–200 characters.");
  if (mode === "elements" || mode === "system")
    return parseElements(normalized).join(",");
  if (mode === "formula") validateFormula(normalized);
  return normalized;
}
// Keep the readable chemical-system convention separate from API serialization.
// Invalid drafts stay untouched so the form can report their validation errors.
export function displaySearchQuery(query: string, mode: SearchMode) {
  if (mode !== "elements" && mode !== "system") return query;
  try {
    return parseElements(query).join("-");
  } catch {
    return query;
  }
}
// Highlights derive from the current input, avoiding a second element-selection state.
export function elementsFromQuery(query: string, mode: SearchMode): string[] {
  if (!query.trim() || ["id", "record", "phase"].includes(mode)) return [];
  try {
    if (mode === "elements" || mode === "system") return parseElements(query);
    if (mode === "any") {
      try {
        return parseElements(query);
      } catch {
        /* Try a complete formula next. */
      }
    }
    return validateFormula(asciiDigits(query));
  } catch {
    return [];
  }
}
export function normalizeFilters(draft: FilterDraft): SearchFilters {
  const result: SearchFilters = {};
  for (const key of Object.keys(resultFilterOptions) as (keyof typeof resultFilterOptions)[]) {
    const value = draft[key];
    if (value) {
      if (!Object.hasOwn(resultFilterOptions[key], value)) throw new Error("Choose a supported result filter.");
      result[key] = value;
    }
  }
  if (draft.excludeElements.trim())
    result.excludeElements = parseElements(draft.excludeElements).join(",");
  if (draft.crystalSystem) {
    if (!crystalSystems.some((system) => system === draft.crystalSystem))
      throw new Error("Choose a valid crystal system.");
    result.crystalSystem = draft.crystalSystem;
  }
  if (draft.spaceGroup.trim()) {
    const group = asciiDigits(draft.spaceGroup).replace(/_/g, "");
    if (/^\d+$/.test(group)) {
      if (Number(group) < 1 || Number(group) > 230)
        throw new Error("Space-group numbers range from 1 to 230.");
    } else if (
      !/^[PABCIFR][A-Za-z0-9\s\/\-]*$/.test(group) ||
      group.length > 40
    )
      throw new Error(
        "Use a space-group number (1–230) or a Hermann–Mauguin symbol, such as Fm-3m.",
      );
    result.spaceGroup = group;
  }
  for (const key of [
    "pressureMin",
    "pressureMax",
    "elementsMin",
    "elementsMax",
  ] as const) {
    const raw = draft[key].trim();
    if (!raw) continue;
    const value = Number(raw);
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ||
      !Number.isFinite(value)
    )
      throw new Error("Range limits must be finite numbers.");
    if (
      key.startsWith("elements") &&
      (!Number.isInteger(value) || value < 1 || value > 118)
    )
      throw new Error(
        "The number of elements must be an integer from 1 to 118.",
      );
    result[key] = value;
  }
  if (
    result.pressureMin != null &&
    result.pressureMax != null &&
    result.pressureMin > result.pressureMax
  )
    throw new Error("The minimum pressure cannot exceed the maximum pressure.");
  if (
    result.elementsMin != null &&
    result.elementsMax != null &&
    result.elementsMin > result.elementsMax
  )
    throw new Error(
      "The minimum element count cannot exceed the maximum element count.",
    );
  return result;
}
export function filtersFromParams(
  params: Pick<URLSearchParams, "get">,
): FilterDraft {
  return Object.fromEntries(
    Object.keys(emptyFilters).map((key) => [
      key,
      key === "excludeElements"
        ? displaySearchQuery(params.get(key) ?? "", "elements")
        : (params.get(key) ?? ""),
    ]),
  ) as FilterDraft;
}
export function buildSearchParams(
  query: string,
  mode: SearchMode,
  filters: SearchFilters = {},
) {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set("type", mode);
    params.set("query", normalizeSearch(query, mode));
  }
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params;
}
export function validateSelection(
  query: string,
  mode: SearchMode,
  filters: SearchFilters,
) {
  const excluded = filters.excludeElements?.split(",") ?? [];
  const overlap = elementsFromQuery(query, mode).filter((symbol) =>
    excluded.includes(symbol),
  );
  if (overlap.length)
    throw new Error(
      `${overlap.join(", ")} cannot be included and excluded in the same search.`,
    );
}
export function searchHref(
  query: string,
  mode: SearchMode,
  filters: SearchFilters = {},
): string {
  validateSelection(query, mode, filters);
  const params = buildSearchParams(query, mode, filters);
  if (!params.size) return "/explore#results";
  return `/explore?${params.toString()}#results`;
}
