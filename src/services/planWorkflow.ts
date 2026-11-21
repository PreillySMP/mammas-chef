// The non-UI plan workflow: everything that makes a generated, swapped or regenerated
// plan correct. Shared by the Planner page and the CLI/MCP, so both produce the same plans.
import { generateAndValidateMealPlan } from "@/services/mealPlanService";
import { streamMealSwap } from "@/services/mealSwapService";
import { streamDayRegeneration } from "@/services/dayRegenerationService";
import { hydrateLibraryRecipeReferences } from "@/services/recipeLibraryService";
import { saveMealPlan } from "@/services/mealPlanDbService";
import { generateShoppingList, type GeneratedShoppingList } from "@/services/shoppingListService";
import { extractPantryItemsFromPrompt, applyPantryStatus } from "@/lib/groceryUtils";
import { buildShoppingListFromRecipes } from "@/lib/shoppingListBuilder";
import {
  parseSwapResponse,
  parseDayRegenerationResponse,
  stripSkippedDayTips,
  SYNTHESIZED_ID_PREFIX,
  type SwapResponse,
  type DayRegenerationResponse,
} from "@/lib/mealPlanParser";
import { applyLeftoverCascade } from "@/lib/leftoverCascade";
import { remapTipRefs } from "@/lib/planEdits";
import { checkPlanCompleteness } from "@/lib/planCompleteness";
import { getOrderedDays } from "@/constants/preferences";
import { isSlotSkipped } from "@/types/mealPlan";
import type { DayPlan, MealPlanResponse, MealRecipe, PrepTip, SkipSlots } from "@/types/mealPlan";
import type { ValidationError } from "@/lib/mealPlanValidation";

/** Sort a days array to match the user's week-start-day preference. */
export function sortDays(days: DayPlan[], weekStart: string): DayPlan[] {
  const order = getOrderedDays(weekStart);
  return [...days].sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));
}

/** Swap the AI's stubs for pinned recipes back to the full pinned recipe (by id, then title). */
export function mergePinnedStubs(days: DayPlan[], pinnedRecipes?: MealRecipe[]): DayPlan[] {
  if (!pinnedRecipes?.length) return days;
  const byId = new Map(pinnedRecipes.map((r) => [r.id, r]));
  const byTitle = new Map(pinnedRecipes.map((r) => [r.title.toLowerCase().trim(), r]));
  return days.map((day) => ({
    ...day,
    meals: day.meals.map((meal) => {
      if (!meal.title) return meal;
      const full = byId.get(meal.id) || byTitle.get(meal.title.toLowerCase().trim());
      return full ? { ...full } : meal;
    }),
  }));
}

/**
 * Post-generation steps: order days, restore pinned recipes, pantry items, library
 * references, skip-violating tip strip, and a locally seeded shopping list.
 * `prompt` is the user's own text (pantry items are read from it).
 */
export async function finalizeGeneratedPlan(
  parsed: MealPlanResponse,
  opts: { prompt: string; weekStart: string; skipSlots?: SkipSlots; pinnedRecipes?: MealRecipe[] },
): Promise<MealPlanResponse> {
  const days = sortDays(mergePinnedStubs(parsed.weekPlan.days, opts.pinnedRecipes), opts.weekStart);
  const pantryItems = extractPantryItemsFromPrompt(opts.prompt);
  const enriched = await hydrateLibraryRecipeReferences({
    ...parsed,
    weekPlan: { ...parsed.weekPlan, days },
    shoppingList: [],
    pantryItems,
    skipSlots: opts.skipSlots,
  });
  const cleaned = stripSkippedDayTips(enriched, opts.skipSlots);
  const seed = buildShoppingListFromRecipes(cleaned.weekPlan.days.flatMap((d) => d.meals.map((m) => ({ ...m, day: d.day }))));
  if (seed.length > 0) cleaned.shoppingList = applyPantryStatus(seed, pantryItems);
  return cleaned;
}

/** Meals the allergen scan flagged; the same test the Planner toast uses. */
export function allergenFlaggedMeals(plan: MealPlanResponse): { day: string; meal: MealRecipe }[] {
  return plan.weekPlan.days.flatMap((d) =>
    d.meals.filter((m) => m.cautionNote?.startsWith("Allergy warning")).map((meal) => ({ day: d.day, meal })),
  );
}

export function countMissingMeals(plan: MealPlanResponse, weekStart: string): number {
  return checkPlanCompleteness(plan.weekPlan.days, getOrderedDays(weekStart), plan.skipSlots).totalMissing;
}

/** A computed change to a plan; apply it with applyPlanEdit. */
export interface PlanEdit {
  weekPlan: MealPlanResponse["weekPlan"];
  /** Undefined keeps the plan's current tips. */
  prepTips?: PrepTip[];
  /** Leftover re-point confirmations, for the user-facing message. */
  cascadeSuffixes: string[];
}

/** Applies an edit; takes the latest plan so other fields (notes etc.) are kept. */
export function applyPlanEdit(plan: MealPlanResponse, edit: PlanEdit): MealPlanResponse {
  return stripSkippedDayTips({
    ...plan,
    weekPlan: edit.weekPlan,
    shoppingList: [],
    prepTips: edit.prepTips ?? plan.prepTips,
  });
}

// ---------- Swap ----------

export function buildSwapRequest(plan: MealPlanResponse, dayIndex: number, mealType: string) {
  const day = plan.weekPlan.days[dayIndex];
  const oldMeal = day?.meals.find((m) => m.mealType === mealType);
  if (!day || !oldMeal) return null;
  const allMeals = plan.weekPlan.days.flatMap((d) => d.meals);
  // All other meals, for variety avoidance.
  const remainingMeals = allMeals.filter((m) => m.id !== oldMeal.id);
  // D-11: dependents of the outgoing meal need the replacement sized to cover them.
  const dependents = allMeals.filter((m) => m.status === "leftover" && m.source_meal_id === oldMeal.id);
  const dependentSource = dependents.length > 0
    ? { count: dependents.length, servingsSum: dependents.reduce((sum, m) => sum + (m.servings ?? 0), 0) }
    : undefined;
  return { day, oldMeal, remainingMeals, dependentSource };
}

/** Places a parsed swap into the plan and re-points leftovers at the new meal. */
export function computeSwapEdit(
  plan: MealPlanResponse,
  dayIndex: number,
  oldMeal: MealRecipe,
  swapResult: SwapResponse,
): PlanEdit & { newMeal: MealRecipe } {
  // Keep the old slot id so favorites/references stay intact, and carry `creates`:
  // swap-meal's schema never emits it, so a batch source would lose its own tag.
  const newMeal = { ...swapResult.newMeal, id: oldMeal.id, creates: oldMeal.creates };
  // Place the replacement BEFORE the cascade: dependents must see it (D-10).
  const days = plan.weekPlan.days.map((d, i) =>
    i !== dayIndex ? d : { ...d, meals: d.meals.map((m) => (m.mealType === oldMeal.mealType ? newMeal : m)) },
  );
  const cascade = applyLeftoverCascade({ ...plan.weekPlan, days }, oldMeal, newMeal);
  return {
    newMeal,
    weekPlan: cascade.weekPlan,
    prepTips: swapResult.updatedPrepTips,
    cascadeSuffixes: cascade.toastDescriptionSuffix ? [cascade.toastDescriptionSuffix] : [],
  };
}

// ---------- Regenerate day ----------

export function buildDayRegenRequest(plan: MealPlanResponse, dayIndex: number, dayLabel?: string) {
  const day = plan.weekPlan.days[dayIndex] as DayPlan | undefined;
  const targetDayLabel = day?.day ?? dayLabel;
  if (!targetDayLabel) return null;
  const activeMealTypes = ["breakfast", "lunch", "dinner", "snack"].filter(
    (t) => !isSlotSkipped(plan.skipSlots, targetDayLabel, t),
  );
  // Meals from other days, for variety avoidance.
  const remainingMeals = plan.weekPlan.days.filter((_, i) => i !== dayIndex).flatMap((d) => d.meals);
  return {
    day,
    targetDayLabel,
    activeMealTypes,
    remainingMeals,
    // The day's current ids (empty for a missing day) opt the edge into prep-tip merging.
    replacedMealIds: day?.meals.map((m) => m.id) ?? [],
  };
}

/** Places a regenerated day into the plan; cascades once per replaced leftover source (D-13). */
export function computeDayRegenEdit(
  plan: MealPlanResponse,
  dayIndex: number,
  targetDayLabel: string,
  regenResult: DayRegenerationResponse,
  weekStart: string,
): PlanEdit {
  const existingDay = plan.weekPlan.days[dayIndex] as DayPlan | undefined;
  // Keep each replaced slot's id so ids stay unique (duplicates collide on save). A slot
  // with no prior meal gets a fresh id: AI ids like "regen-unique-id-1" repeat across calls.
  const idMap = new Map(
    regenResult.newMeals.map((nm) => [
      nm.id,
      existingDay?.meals.find((m) => m.mealType === nm.mealType)?.id
        ?? `${SYNTHESIZED_ID_PREFIX}${globalThis.crypto?.randomUUID?.() ?? `${targetDayLabel}-${nm.mealType}-${Date.now()}`}`,
    ]),
  );
  const newMeals = regenResult.newMeals.map((nm) => ({
    ...nm,
    id: idMap.get(nm.id) ?? nm.id,
    // A same-day leftover pair links via an AI-era id; remap it through the same map.
    source_meal_id: nm.source_meal_id && idMap.has(nm.source_meal_id) ? idMap.get(nm.source_meal_id) : nm.source_meal_id,
  }));
  // The edge tags this day's tips with the model's ids; map them to the ids the plan holds.
  const prepTips = regenResult.updatedPrepTips && remapTipRefs(regenResult.updatedPrepTips, idMap);

  const updatedDays = plan.weekPlan.days.map((d, i) => (i !== dayIndex ? d : { ...d, meals: newMeals }));
  const nextDays = existingDay
    ? updatedDays
    : sortDays([...updatedDays, { day: targetDayLabel, meals: newMeals }], weekStart);

  let weekPlan = { ...plan.weekPlan, days: nextDays };
  const cascadeSuffixes: string[] = [];
  if (existingDay) {
    for (const newMeal of newMeals) {
      const oldMeal = existingDay.meals.find((m) => m.mealType === newMeal.mealType);
      if (!oldMeal) continue;
      const cascade = applyLeftoverCascade(weekPlan, oldMeal, newMeal);
      weekPlan = cascade.weekPlan;
      if (cascade.toastDescriptionSuffix) cascadeSuffixes.push(cascade.toastDescriptionSuffix);
    }
  }
  return { weekPlan, prepTips, cascadeSuffixes };
}

// ---------- Promise-based entry points (CLI / MCP) ----------

type StreamCallbacks = { onDelta: (s: string) => void; onDone: () => void; onError: (e: string) => void };

function collectStream(run: (cb: StreamCallbacks) => Promise<unknown>, onDelta?: (s: string) => void) {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    run({
      onDelta: (s) => { text += s; onDelta?.(s); },
      onDone: () => resolve(text),
      onError: (e) => reject(new Error(e)),
    }).catch(reject);
  });
}

/** Generates and finalizes a plan (not saved). Rejects on transport error or failed validation. */
export function createPlan(opts: {
  prompt: string;
  weekStart: string;
  accessToken: string;
  skipSlots?: SkipSlots;
  startDate?: string;
  pinnedRecipes?: MealRecipe[];
  onDelta?: (s: string) => void;
  onRetryStart?: (errors: ValidationError[]) => void;
}): Promise<MealPlanResponse> {
  return new Promise((resolve, reject) => {
    generateAndValidateMealPlan({
      // Same suffix the Planner adds. Only the request gets it: pantry items are read from opts.prompt.
      prompt: opts.prompt + (opts.pinnedRecipes?.length ? " Incorporate my pinned recipes." : ""),
      pinnedRecipes: opts.pinnedRecipes,
      skipSlots: opts.skipSlots,
      startDate: opts.startDate,
      accessToken: opts.accessToken,
      onDelta: opts.onDelta ?? (() => {}),
      onRetryStart: opts.onRetryStart ?? (() => {}),
      onSuccess: (parsed) =>
        finalizeGeneratedPlan(parsed, opts).then(resolve, reject),
      onError: (msg) => reject(new Error(msg)),
      onValidationFailed: ({ errors }) =>
        reject(new Error(`The plan had unresolved references after a retry: ${errors.map((e) => e.message).join("; ")}`)),
    }).catch(reject);
  });
}

/** Replaces one meal. Returns the edited plan (not saved). */
export async function swapMeal(
  plan: MealPlanResponse,
  opts: { dayIndex: number; mealType: string; hint?: string; accessToken: string; onDelta?: (s: string) => void },
): Promise<{ plan: MealPlanResponse; newMeal: MealRecipe; cascadeSuffixes: string[] }> {
  const req = buildSwapRequest(plan, opts.dayIndex, opts.mealType);
  if (!req) throw new Error(`No ${opts.mealType} on that day to swap.`);
  const text = await collectStream((cb) => streamMealSwap({
    oldMeal: req.oldMeal,
    dayLabel: req.day.day,
    mealType: opts.mealType,
    remainingMeals: req.remainingMeals,
    currentPrepTips: plan.prepTips ?? [],
    hint: opts.hint,
    dependentSource: req.dependentSource,
    skipSlots: plan.skipSlots,
    accessToken: opts.accessToken,
    ...cb,
  }), opts.onDelta);
  const edit = computeSwapEdit(plan, opts.dayIndex, req.oldMeal, parseSwapResponse(text));
  return { plan: applyPlanEdit(plan, edit), newMeal: edit.newMeal, cascadeSuffixes: edit.cascadeSuffixes };
}

/** Replaces a day's meals. Returns the edited plan (not saved). */
export async function regenerateDay(
  plan: MealPlanResponse,
  opts: { dayIndex: number; dayLabel?: string; hint?: string; weekStart: string; accessToken: string; onDelta?: (s: string) => void },
): Promise<{ plan: MealPlanResponse; cascadeSuffixes: string[] }> {
  const req = buildDayRegenRequest(plan, opts.dayIndex, opts.dayLabel);
  if (!req) throw new Error("No day to regenerate.");
  const text = await collectStream((cb) => streamDayRegeneration({
    dayLabel: req.targetDayLabel,
    activeMealTypes: req.activeMealTypes,
    remainingMeals: req.remainingMeals,
    currentPrepTips: plan.prepTips ?? [],
    hint: opts.hint,
    batches: plan.weekPlan.batches?.length ? plan.weekPlan.batches : undefined,
    skipSlots: plan.skipSlots,
    replacedMealIds: req.replacedMealIds,
    accessToken: opts.accessToken,
    ...cb,
  }), opts.onDelta);
  const edit = computeDayRegenEdit(plan, opts.dayIndex, req.targetDayLabel, parseDayRegenerationResponse(text), opts.weekStart);
  return { plan: applyPlanEdit(plan, edit), cascadeSuffixes: edit.cascadeSuffixes };
}

/**
 * Saves a plan, then builds and stores its shopping list (awaited, unlike the Planner,
 * which runs that in the background). A failed list doesn't undo the saved plan.
 */
export async function savePlanWithShoppingList(
  userId: string,
  plan: MealPlanResponse,
  opts: { weekStart: string; startDate?: Date; existingPlanId?: string },
): Promise<{ planId: string; missingMeals: number; shoppingList: GeneratedShoppingList | null; shoppingListError?: string }> {
  const planId = await saveMealPlan(userId, plan, opts.startDate, opts.existingPlanId);
  const missingMeals = countMissingMeals(plan, opts.weekStart);
  try {
    return { planId, missingMeals, shoppingList: await generateShoppingList(planId) };
  } catch (e) {
    return { planId, missingMeals, shoppingList: null, shoppingListError: e instanceof Error ? e.message : String(e) };
  }
}
