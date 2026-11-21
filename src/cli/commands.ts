// Plan commands shared by the CLI and MCP mode. Each returns a plain JSON-ready object.
import { readFileSync } from "node:fs";
import { format, isValid, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { loadMealPlan, deleteMealPlan, addFavorite, getFavorites } from "@/services/mealPlanDbService";
import { listSavedPlans } from "@/services/savedPlansService";
import { generateShoppingList, type GeneratedShoppingList } from "@/services/shoppingListService";
import {
  searchRecipeLibrary, recipeLibraryRowToMealRecipe, addLibraryRecipeToPlan, getRecipeLibraryMealRecipe,
} from "@/services/recipeLibraryService";
import {
  createPlan, swapMeal, regenerateDay, savePlanWithShoppingList, allergenFlaggedMeals, countMissingMeals, sortDays,
} from "@/services/planWorkflow";
import { buildWeekSkipSlots, DEFAULT_INCLUDED_MEALS, PLANNER_V2_MEAL_TYPES } from "@/lib/plannerV2Slots";
import {
  ALL_WEEKDAYS, ALLERGY_OPTIONS, CUISINE_OPTIONS, DIETARY_OPTIONS, WEEK_START_OPTIONS, getNextStartDate, getOrderedDays,
} from "@/constants/preferences";
import { checkAllergens, markAllergenCautions } from "../../supabase/functions/_shared/allergens";
import type { MealPlanResponse, MealRecipe } from "@/types/mealPlan";

export const NOTICE = "AI-written. If anyone has a food allergy, check every ingredient and label yourself.";

/** An expected failure: the message is shown to the user as-is. */
export class CliError extends Error {}

// ---------- Session and profile ----------

async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new CliError("Not signed in. The user needs to run `mammaschef init` in a terminal.");
  return session;
}

const PROFILE_COLUMNS =
  "household_size, allergies, dietary_preferences, preferred_cuisines, toddler_friendly, glucose_friendly, week_start_day, onboarding_complete";

export async function getProfile() {
  const session = await requireSession();
  const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", session.user.id).single();
  if (error) throw new Error(error.message);
  return { email: session.user.email ?? null, ...data, allergies: data.allergies ?? [] };
}

// Common words people (and agents) use for the app's allergy options.
export const ALLERGY_ALIASES: Record<string, string> = {
  dairy: "Milk", lactose: "Milk", nut: "Nuts", "tree nut": "Nuts", "tree nuts": "Nuts",
  peanut: "Peanuts", egg: "Eggs", gluten: "Wheat", shellfish: "Shellfish", sesame: "Sesame",
};

/** Maps names to the app's spelling (case-insensitive); unknown names are an error, never silently dropped. */
export function canonicalize(values: string[], options: readonly string[], label: string, aliases: Record<string, string> = {}) {
  return values.map((raw) => {
    const v = raw.trim().toLowerCase();
    const match = options.find((o) => o.toLowerCase() === v) ?? aliases[v];
    if (!match) throw new CliError(`Unknown ${label} "${raw.trim()}". Choose from: ${options.join(", ")}.`);
    return match;
  });
}

export interface ProfileChanges {
  household?: number;
  allergies?: string[];
  diet?: string[];
  cuisines?: string[];
  toddler?: boolean;
  glucose?: boolean;
  weekStart?: string;
}

export async function updateProfile(changes: ProfileChanges) {
  const session = await requireSession();
  const row: Record<string, unknown> = {};
  if (changes.household !== undefined) {
    if (!Number.isInteger(changes.household) || changes.household < 1 || changes.household > 20) {
      throw new CliError("Household size must be a whole number from 1 to 20.");
    }
    row.household_size = changes.household;
  }
  if (changes.allergies) row.allergies = [...new Set(canonicalize(changes.allergies, ALLERGY_OPTIONS, "allergy", ALLERGY_ALIASES))];
  if (changes.diet) row.dietary_preferences = canonicalize(changes.diet, DIETARY_OPTIONS, "diet");
  if (changes.cuisines) row.preferred_cuisines = canonicalize(changes.cuisines, CUISINE_OPTIONS, "cuisine");
  if (changes.toddler !== undefined) row.toddler_friendly = changes.toddler;
  if (changes.glucose !== undefined) row.glucose_friendly = changes.glucose;
  if (changes.weekStart) row.week_start_day = canonicalize([changes.weekStart], WEEK_START_OPTIONS, "week start")[0];
  if (Object.keys(row).length === 0) throw new CliError("Nothing to change. See `mammaschef help` for profile options.");
  const { error } = await supabase.from("profiles").update(row).eq("id", session.user.id);
  if (error) throw new Error(error.message);
  return getProfile();
}

// ---------- Addressing plans, days and meals ----------

async function resolvePlanId(userId: string, ref: string) {
  const plans = await listSavedPlans(userId);
  if (plans.length === 0) throw new CliError("No saved plans yet. Create one first (`mammaschef plan` or the create_plan tool).");
  if (ref === "latest") return plans[0].id;
  const matches = plans.filter((p) => p.id.startsWith(ref));
  if (matches.length === 1) return matches[0].id;
  throw new CliError(matches.length > 1
    ? `"${ref}" matches more than one plan. Use more of the id.`
    : `No plan "${ref}". Run \`mammaschef plans\` to list them, or use "latest".`);
}

function canonicalDay(ref: string) {
  const v = ref.trim().toLowerCase();
  const day = v.length >= 3 ? ALL_WEEKDAYS.find((d) => d.toLowerCase().startsWith(v)) : undefined;
  if (!day) throw new CliError(`Unknown day "${ref}". Use a weekday such as Tuesday.`);
  return day;
}

function canonicalMealType(ref: string) {
  const v = ref.trim().toLowerCase();
  const meal = PLANNER_V2_MEAL_TYPES.find((m) => m === v);
  if (!meal) throw new CliError(`Unknown meal "${ref}". Use breakfast, lunch, dinner or snack.`);
  return meal;
}

/** Loads a plan for editing; ids in it are the saved row ids, which in-place saves rely on. */
async function loadPlan(ref: string) {
  const session = await requireSession();
  const profile = await getProfile();
  const weekStart = profile.week_start_day ?? "Sunday";
  const planId = await resolvePlanId(session.user.id, ref);
  const plan = await loadMealPlan(planId);
  plan.weekPlan.days = sortDays(plan.weekPlan.days, weekStart);
  return { session, weekStart, planId, plan };
}

function findMeal(plan: MealPlanResponse, dayRef: string, mealRef: string) {
  const day = canonicalDay(dayRef);
  const mealType = canonicalMealType(mealRef);
  const dayIndex = plan.weekPlan.days.findIndex((d) => d.day === day);
  const meal = plan.weekPlan.days[dayIndex]?.meals.find((m) => m.mealType === mealType);
  if (!meal) throw new CliError(`This plan has no ${mealType} on ${day}.`);
  return { day, mealType, dayIndex, meal };
}

// ---------- Result shape ----------

export function secondOpinionCheck(envFile = "supabase/functions/.env"): "on" | "off" {
  try {
    return /^AI_GATEWAY_API_KEY=.+/m.test(readFileSync(envFile, "utf8")) ? "on" : "off";
  } catch {
    return "off";
  }
}

/** The fields every plan result carries, so warnings always travel with the plan. */
export function planSummary(planId: string, plan: MealPlanResponse, weekStart: string) {
  return {
    plan_id: planId,
    title: plan.weekPlan.title,
    start_date: plan.startDate ?? null,
    allergen_warnings: allergenFlaggedMeals(plan).map(({ day, meal }) => ({
      day, meal: meal.mealType, title: meal.title, note: meal.cautionNote ?? "",
    })),
    second_opinion_check: secondOpinionCheck(),
    missing_meals: countMissingMeals(plan, weekStart),
    notice: NOTICE,
  };
}

function mealView(meal: MealRecipe, full: boolean) {
  return {
    meal: meal.mealType,
    title: meal.title,
    status: meal.status ?? "fresh",
    caution: meal.cautionNote ?? null,
    servings: meal.servings,
    prep_time: meal.prepTime,
    ...(full ? { ingredients: meal.ingredients, steps: meal.steps, toddler_tip: meal.toddlerTip ?? null } : {}),
  };
}

async function reloadSummary(planId: string, weekStart: string) {
  const plan = await loadMealPlan(planId);
  plan.weekPlan.days = sortDays(plan.weekPlan.days, weekStart);
  return { plan, summary: planSummary(planId, plan, weekStart) };
}

function startDateOf(plan: MealPlanResponse) {
  return plan.startDate ? parseISO(plan.startDate) : undefined;
}

/** How the shopping list came out, so a saved plan with a failed list isn't reported as all done. */
export function shoppingListResult(saved: { shoppingList: GeneratedShoppingList | null; shoppingListError?: string }) {
  const list = saved.shoppingList;
  if (!list) return { status: "failed" as const, items: 0, written_by: null, error: saved.shoppingListError ?? "Unknown error." };
  return {
    status: list.saveError ? "not_saved" as const : "saved" as const,
    items: list.items.length,
    written_by: list.source.startsWith("ai") ? "ai" as const : "local_fallback" as const,
    error: list.saveError ?? null,
  };
}

// ---------- Pinned recipes and favorites ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OLD_ALLERGY_NOTE = /^Allergy warning: may contain [^.]*\. Check every ingredient before cooking\.\s*/;
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Pinned recipes and favorites skip the planner's allergen scan, and a favorite may carry a
 * warning written for an older allergy list, so scan them against the profile as it is now.
 */
export function withAllergyWarnings(recipes: MealRecipe[], allergies: string[]): MealRecipe[] {
  const fresh = recipes.map((r) => ({ ...r, cautionNote: r.cautionNote?.replace(OLD_ALLERGY_NOTE, "") || undefined }));
  markAllergenCautions(fresh, checkAllergens(fresh, allergies));
  return fresh;
}

/** A pin is a library recipe_id or the title of a favorite; an unknown one is an error, never silently dropped. */
async function resolvePins(userId: string, refs: string[]): Promise<MealRecipe[]> {
  const favorites = refs.some((r) => !UUID.test(r.trim())) ? await getFavorites(userId) : [];
  return Promise.all(refs.map(async (raw) => {
    const ref = raw.trim();
    if (UUID.test(ref)) {
      return getRecipeLibraryMealRecipe(ref).catch(() => { throw new CliError(`No library recipe "${ref}". Use a recipe_id from search_recipes.`); });
    }
    const favorite = favorites.find((f) => sameTitle(f.recipe_data.title, ref));
    if (!favorite) throw new CliError(`No favorite called "${ref}". Use a title from list_favorites, or a recipe_id from search_recipes.`);
    return favorite.recipe_data;
  }));
}

// ---------- Commands ----------

export async function makePlan(opts: {
  request: string; startDate?: string; meals?: string[]; skipDays?: string[];
  /** Library recipe_ids or favorite titles to build the week around. */
  pinned?: string[];
  /** Refuse when the week already has a plan (MCP mode: an agent may retry a call that timed out). */
  refuseDuplicateWeek?: boolean;
}) {
  const session = await requireSession();
  const profile = await getProfile();
  const weekStart = profile.week_start_day ?? "Sunday";
  const start = opts.startDate ? parseISO(opts.startDate) : getNextStartDate(weekStart);
  if (!isValid(start)) throw new CliError(`Start date "${opts.startDate}" isn't a date. Use YYYY-MM-DD.`);
  const startDate = format(start, "yyyy-MM-dd");
  const meals = opts.meals ? opts.meals.map(canonicalMealType) : DEFAULT_INCLUDED_MEALS;
  const skipSlots = buildWeekSkipSlots(getOrderedDays(weekStart), meals, (opts.skipDays ?? []).map(canonicalDay));

  if (opts.refuseDuplicateWeek) {
    // shortcut: check-then-create, so two calls in separate server processes can both pass; move the check into the database if that ever happens.
    const existing = (await listSavedPlans(session.user.id)).find((p) => p.start_date === startDate);
    if (existing) {
      throw new CliError(`There is already a plan for the week of ${startDate}: "${existing.title}" (plan_id ${existing.id}). If a create_plan call just timed out, this is probably its result, so read it with get_plan. To make another plan for the same week, ask the user first, then call again with allow_duplicate set to true.`);
    }
  }
  const pinned = withAllergyWarnings(await resolvePins(session.user.id, opts.pinned ?? []), profile.allergies);

  const plan = await createPlan({
    prompt: opts.request.trim() || "Generate a meal plan for the selected meal slots.",
    weekStart,
    accessToken: session.access_token,
    skipSlots: Object.keys(skipSlots).length > 0 ? skipSlots : undefined,
    startDate,
    pinnedRecipes: pinned.length > 0 ? pinned : undefined,
  });
  const saved = await savePlanWithShoppingList(session.user.id, plan, { weekStart, startDate: start });
  const { plan: savedPlan, summary } = await reloadSummary(saved.planId, weekStart);
  return {
    ...summary,
    shopping_list: shoppingListResult(saved),
    // day is null when the planner left a pinned recipe out.
    pinned: pinned.map((p) => ({
      title: p.title,
      day: savedPlan.weekPlan.days.find((d) => d.meals.some((m) => sameTitle(m.title, p.title)))?.day ?? null,
    })),
  };
}

export async function listPlans() {
  const session = await requireSession();
  const plans = await listSavedPlans(session.user.id);
  return { plans: plans.map((p) => ({ plan_id: p.id, title: p.title, start_date: p.start_date, meals: p.mealCount, created_at: p.created_at })) };
}

export async function showPlan(ref: string, full = false) {
  const { weekStart, planId, plan } = await loadPlan(ref);
  return {
    ...planSummary(planId, plan, weekStart),
    notes: plan.notes ?? "",
    days: plan.weekPlan.days.map((d) => ({
      day: d.day,
      meals: [...d.meals]
        .sort((a, b) => PLANNER_V2_MEAL_TYPES.indexOf(a.mealType) - PLANNER_V2_MEAL_TYPES.indexOf(b.mealType))
        .map((m) => mealView(m, full)),
    })),
  };
}

export async function swap(ref: string, dayRef: string, mealRef: string, hint?: string) {
  const { session, weekStart, planId, plan } = await loadPlan(ref);
  const { day, mealType, dayIndex, meal } = findMeal(plan, dayRef, mealRef);
  const result = await swapMeal(plan, { dayIndex, mealType, hint, accessToken: session.access_token });
  const saved = await savePlanWithShoppingList(session.user.id, result.plan, { weekStart, startDate: startDateOf(plan), existingPlanId: planId });
  const { summary } = await reloadSummary(planId, weekStart);
  return {
    ...summary, shopping_list: shoppingListResult(saved),
    changed: { day, meal: mealType, from: meal.title, to: result.newMeal.title }, leftovers_updated: result.cascadeSuffixes,
  };
}

export async function regen(ref: string, dayRef: string, hint?: string) {
  const { session, weekStart, planId, plan } = await loadPlan(ref);
  const day = canonicalDay(dayRef);
  const found = plan.weekPlan.days.findIndex((d) => d.day === day);
  // A day missing from the plan is added (dayIndex past the end), as in the website.
  const dayIndex = found >= 0 ? found : plan.weekPlan.days.length;
  const before = plan.weekPlan.days[found]?.meals.map((m) => m.title) ?? [];
  const result = await regenerateDay(plan, { dayIndex, dayLabel: day, hint, weekStart, accessToken: session.access_token });
  const list = await savePlanWithShoppingList(session.user.id, result.plan, { weekStart, startDate: startDateOf(plan), existingPlanId: planId });
  const { plan: saved, summary } = await reloadSummary(planId, weekStart);
  const after = saved.weekPlan.days.find((d) => d.day === day)?.meals.map((m) => m.title) ?? [];
  return { ...summary, shopping_list: shoppingListResult(list), changed: { day, from: before, to: after }, leftovers_updated: result.cascadeSuffixes };
}

export async function shopping(ref: string) {
  const { weekStart, planId, plan } = await loadPlan(ref);
  const items = plan.shoppingList.length > 0 ? plan.shoppingList : (await generateShoppingList(planId)).items;
  const aisles = new Map<string, { item: string; quantity: string; on_hand: boolean }[]>();
  for (const i of items) {
    const list = aisles.get(i.aisle || "Other") ?? [];
    list.push({ item: i.name, quantity: i.quantity, on_hand: i.status === "on_hand" });
    aisles.set(i.aisle || "Other", list);
  }
  return {
    plan_id: planId,
    title: plan.weekPlan.title,
    allergen_warnings: planSummary(planId, plan, weekStart).allergen_warnings,
    notice: NOTICE,
    aisles: [...aisles].map(([aisle, list]) => ({ aisle, items: list })),
  };
}

export async function searchRecipes(query: string) {
  const profile = await getProfile();
  const rows = (await searchRecipeLibrary({}, query)).slice(0, 10);
  return {
    recipes: rows.map((row) => {
      const recipe = recipeLibraryRowToMealRecipe(row);
      const allergens = [...new Set(checkAllergens([recipe], profile.allergies).map((v) => v.allergen))];
      return {
        recipe_id: row.id,
        title: row.title,
        meal_types: row.meal_types ?? [],
        total_minutes: row.total_time_minutes ?? null,
        allergen_warning: allergens.length ? `May contain ${allergens.join(", ")}.` : null,
      };
    }),
  };
}

export async function addRecipe(ref: string, dayRef: string, mealRef: string, recipeId: string) {
  const { weekStart, planId } = await loadPlan(ref);
  const day = canonicalDay(dayRef);
  const mealType = canonicalMealType(mealRef);
  const { data: dayRow } = await supabase
    .from("meal_plan_days").select("id").eq("meal_plan_id", planId).eq("day_name", day).maybeSingle();
  if (!dayRow) throw new CliError(`This plan has no ${day}. Run \`mammaschef regen ${planId.slice(0, 8)} ${day}\` to add it.`);
  // Replaces whatever is in the slot; the allergen scan runs inside the shared insert.
  const added = await addLibraryRecipeToPlan(recipeId, dayRow.id, mealType, true);
  const { plan: saved, summary } = await reloadSummary(planId, weekStart);
  // The shared insert rebuilds the list but swallows a failure, so read the outcome off the stored list.
  const items = saved.shoppingList.length;
  const shopping_list = items > 0
    ? { status: "saved" as const, items, written_by: null, error: null }
    : { status: "failed" as const, items, written_by: null, error: "The shopping list could not be rebuilt after this change." };
  return { ...summary, shopping_list, changed: { day, meal: mealType, to: added.title } };
}

export async function favorite(ref: string, dayRef: string, mealRef: string) {
  const { session, plan } = await loadPlan(ref);
  const { day, mealType, meal } = findMeal(plan, dayRef, mealRef);
  await addFavorite(session.user.id, meal);
  return { saved: true, day, meal: mealType, title: meal.title };
}

export async function listFavorites() {
  const session = await requireSession();
  const profile = await getProfile();
  const favorites = withAllergyWarnings((await getFavorites(session.user.id)).map((f) => f.recipe_data), profile.allergies);
  return {
    favorites: favorites.map((r) => ({
      title: r.title,
      meal: r.mealType,
      servings: r.servings,
      prep_time: r.prepTime,
      allergen_warning: r.cautionNote?.startsWith("Allergy warning") ? r.cautionNote : null,
    })),
  };
}

export async function deletePlan(ref: string) {
  const session = await requireSession();
  const planId = await resolvePlanId(session.user.id, ref);
  await deleteMealPlan(planId, "cli");
  return { deleted: planId };
}
