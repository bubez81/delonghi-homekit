import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RecipeSpec } from './protocol.js';

export interface MachineModel {
  productCode: string;
  name: string;
  type?: string;
  protocolVersion?: number;
  nProfiles?: number;
  cupLight: boolean;
  timeSettings: boolean;
  autoOff: boolean;
  buzzer: boolean;
  energySaving: boolean;
  waterHardness: boolean;
  filter: boolean;
  imageUrl?: string;
  recipes: Array<{ id: number; name: string; coffeeQty: number; milkQty: number }>;
}

let cache: MachineModel[] | undefined;

export function loadModels(): MachineModel[] {
  if (!cache) {
    const file = fileURLToPath(new URL('../data/models.json', import.meta.url));
    cache = (JSON.parse(readFileSync(file, 'utf8')) as { machines: MachineModel[] }).machines;
  }
  return cache;
}

export function modelByProductCode(code?: string): MachineModel | undefined {
  if (!code) return undefined;
  return loadModels().find(m => m.productCode === code);
}

/** Same heuristic as the HA integration: "D1533201" -> product code ending in "15332". */
export function guessModel(bleName?: string): MachineModel | undefined {
  if (!bleName) return undefined;
  const base = bleName.startsWith('D') ? bleName.slice(1) : bleName;
  if (base.length <= 2) return undefined;
  const suffix = base.slice(0, -2);
  return loadModels().find(m => m.productCode?.endsWith(suffix));
}

/** Fallback when the model is unknown: the beverages with captured commands. */
export const DEFAULT_RECIPES: RecipeSpec[] = [
  { id: 1, name: 'Espresso Coffee', coffeeQty: 40, milkQty: 0 },
  { id: 2, name: 'Regular Coffee', coffeeQty: 103, milkQty: 0 },
  { id: 3, name: 'Long Coffee', coffeeQty: 160, milkQty: 0 },
  { id: 4, name: '2X Espresso Coffee', coffeeQty: 40, milkQty: 0 },
  { id: 5, name: 'Doppio+', coffeeQty: 120, milkQty: 0 },
  { id: 6, name: 'Americano', coffeeQty: 40, milkQty: 0, hotWaterQty: 110 },
  { id: 16, name: 'Hot Water', coffeeQty: 0, milkQty: 0, hotWaterQty: 250 },
];

/** Recipes of a model with unique display names ("Custom 1", "Custom 2"...). */
export function recipesFor(model?: MachineModel): RecipeSpec[] {
  if (!model || model.recipes.length === 0) return DEFAULT_RECIPES;
  const out: RecipeSpec[] = [];
  const seen = new Set<string>();
  let custom = 0;
  for (const r of model.recipes) {
    let name = r.name;
    if (name === 'Custom') name = `Custom ${++custom}`;
    else if (seen.has(name)) name = `${name} (${r.id})`;
    seen.add(name);
    out.push({
      id: r.id,
      name,
      coffeeQty: r.coffeeQty,
      milkQty: r.milkQty,
      hotWaterQty: r.id === 16 ? r.coffeeQty : undefined,
    });
  }
  // Hot water lists its quantity as "coffee" in the catalog.
  for (const r of out) if (r.id === 16) r.coffeeQty = 0;
  return out;
}
