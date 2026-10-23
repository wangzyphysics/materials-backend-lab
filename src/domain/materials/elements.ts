// Standard element identities and conventional 18-column periodic-table positions.
// These are reference chemistry metadata, not database availability or material records.
const identities = `H Hydrogen;He Helium;Li Lithium;Be Beryllium;B Boron;C Carbon;N Nitrogen;O Oxygen;F Fluorine;Ne Neon;Na Sodium;Mg Magnesium;Al Aluminium;Si Silicon;P Phosphorus;S Sulfur;Cl Chlorine;Ar Argon;K Potassium;Ca Calcium;Sc Scandium;Ti Titanium;V Vanadium;Cr Chromium;Mn Manganese;Fe Iron;Co Cobalt;Ni Nickel;Cu Copper;Zn Zinc;Ga Gallium;Ge Germanium;As Arsenic;Se Selenium;Br Bromine;Kr Krypton;Rb Rubidium;Sr Strontium;Y Yttrium;Zr Zirconium;Nb Niobium;Mo Molybdenum;Tc Technetium;Ru Ruthenium;Rh Rhodium;Pd Palladium;Ag Silver;Cd Cadmium;In Indium;Sn Tin;Sb Antimony;Te Tellurium;I Iodine;Xe Xenon;Cs Caesium;Ba Barium;La Lanthanum;Ce Cerium;Pr Praseodymium;Nd Neodymium;Pm Promethium;Sm Samarium;Eu Europium;Gd Gadolinium;Tb Terbium;Dy Dysprosium;Ho Holmium;Er Erbium;Tm Thulium;Yb Ytterbium;Lu Lutetium;Hf Hafnium;Ta Tantalum;W Tungsten;Re Rhenium;Os Osmium;Ir Iridium;Pt Platinum;Au Gold;Hg Mercury;Tl Thallium;Pb Lead;Bi Bismuth;Po Polonium;At Astatine;Rn Radon;Fr Francium;Ra Radium;Ac Actinium;Th Thorium;Pa Protactinium;U Uranium;Np Neptunium;Pu Plutonium;Am Americium;Cm Curium;Bk Berkelium;Cf Californium;Es Einsteinium;Fm Fermium;Md Mendelevium;No Nobelium;Lr Lawrencium;Rf Rutherfordium;Db Dubnium;Sg Seaborgium;Bh Bohrium;Hs Hassium;Mt Meitnerium;Ds Darmstadtium;Rg Roentgenium;Cn Copernicium;Nh Nihonium;Fl Flerovium;Mc Moscovium;Lv Livermorium;Ts Tennessine;Og Oganesson`;
export const elementIdentities = identities.split(";").map((pair, index) => {
  const [symbol, name] = pair.split(" ");
  return { symbol, name, number: index + 1 };
});
export const elementSymbols = new Set(elementIdentities.map((e) => e.symbol));
const rows = [
  "H _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ He",
  "Li Be _ _ _ _ _ _ _ _ _ _ B C N O F Ne",
  "Na Mg _ _ _ _ _ _ _ _ _ _ Al Si P S Cl Ar",
  "K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr",
  "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe",
  "Cs Ba Ln Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn",
  "Fr Ra An Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og",
  "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _",
  "_ _ La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu _",
  "_ _ Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr _",
];
export type ElementFamily = "s-block" | "d-block" | "p-block" | "f-block";
export type PeriodicCell = {
  symbol: string;
  name: string;
  number: number | null;
  row: number;
  column: number;
  family: ElementFamily;
};
export const periodicCells: PeriodicCell[] = rows.flatMap((row, r) =>
  row.split(" ").flatMap<PeriodicCell>((symbol, c) => {
    if (symbol === "_") return [];
    const identity = elementIdentities.find((e) => e.symbol === symbol);
    if (!identity)
      return [
        {
          symbol,
          name: symbol === "Ln" ? "Lanthanides" : "Actinides",
          number: null,
          row: r + 1,
          column: c + 1,
          family: "f-block" as ElementFamily,
        },
      ];
    const family: ElementFamily =
      r >= 8
        ? "f-block"
        : c < 2 || symbol === "He"
          ? "s-block"
          : c < 12
            ? "d-block"
            : "p-block";
    return [{ ...identity, row: r + 1, column: c + 1, family }];
  }),
);
