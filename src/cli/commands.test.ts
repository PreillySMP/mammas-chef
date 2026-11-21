// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MealPlanResponse, MealRecipe } from "@/types/mealPlan";

const meal = (o: Partial<MealRecipe>) => ({
  id: "m", title: "Soup", mealType: "dinner", prepTime: "20 min", servings: 4, calories: 400, protein: 0, carbs: 0, fats: 0,
  tags: [], ingredients: [], steps: [], ...o,
}) as MealRecipe;

const pasta = meal({
  id: "fav-1", title: "Usual Pasta",
  ingredients: [{ name: "walnut pesto", quantity: 1, unit: "cup" }],
  // Written when the profile listed Sesame; the profile now lists Nuts.
  cautionNote: "Allergy warning: may contain Sesame. Check every ingredient before cooking. High sodium",
});
const savedPlan = {
  weekPlan: { title: "Week of Nov 22", days: [{ day: "Monday", meals: [pasta] }] },
  shoppingList: [], prepTips: [], startDate: "2026-11-22",
} as MealPlanResponse;

const profile = { allergies: ["Nuts"], week_start_day: "Sunday" };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: null }, access_token: "t" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }) }) }) }),
  },
}));
vi.mock("@/services/savedPlansService", () => ({ listSavedPlans: vi.fn() }));
vi.mock("@/services/mealPlanDbService", () => ({
  loadMealPlan: vi.fn(async () => savedPlan),
  getFavorites: vi.fn(async () => [{ recipe_title: "recipe:fav-1", recipe_data: pasta }]),
  deleteMealPlan: vi.fn(), addFavorite: vi.fn(),
}));
vi.mock("@/services/planWorkflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/planWorkflow")>()),
  createPlan: vi.fn(async () => savedPlan),
  savePlanWithShoppingList: vi.fn(async () => ({ planId: "new-plan", missingMeals: 0, shoppingList: null, shoppingListError: "AI down" })),
}));

import { CliError, listFavorites, makePlan, shoppingListResult } from "./commands";
import { listSavedPlans } from "@/services/savedPlansService";
import { createPlan } from "@/services/planWorkflow";

beforeEach(() => {
  vi.mocked(createPlan).mockClear();
  vi.mocked(listSavedPlans).mockResolvedValue([]);
});

describe("makePlan", () => {
  it("refuses a second plan for a week that has one, unless duplicates are allowed", async () => {
    vi.mocked(listSavedPlans).mockResolvedValue([{ id: "old-plan", title: "Week of Nov 22", created_at: "", start_date: "2026-11-22", mealCount: 21 }]);
    const opts = { request: "next week", startDate: "2026-11-22" };
    await expect(makePlan({ ...opts, refuseDuplicateWeek: true })).rejects.toThrow(/already a plan for the week of 2026-11-22.*plan_id old-plan.*allow_duplicate/);
    expect(createPlan).not.toHaveBeenCalled();

    await expect(makePlan(opts)).resolves.toMatchObject({ plan_id: "new-plan" });
    expect(createPlan).toHaveBeenCalledTimes(1);
  });

  it("pins a favorite by title with a fresh allergy warning, and reports where it landed and a failed list", async () => {
    const result = await makePlan({ request: "we have rice", startDate: "2026-11-22", pinned: [" usual pasta "] });
    const sent = vi.mocked(createPlan).mock.calls[0][0].pinnedRecipes!;
    expect(sent[0].cautionNote).toBe("Allergy warning: may contain Nuts. Check every ingredient before cooking. High sodium");
    expect(result.pinned).toEqual([{ title: "Usual Pasta", day: "Monday" }]);
    expect(result.shopping_list).toEqual({ status: "failed", items: 0, written_by: null, error: "AI down" });
  });

  it("rejects a pin it can't find instead of dropping it", async () => {
    await expect(makePlan({ request: "", pinned: ["Mystery Stew"] })).rejects.toThrow(CliError);
    expect(createPlan).not.toHaveBeenCalled();
  });
});

describe("listFavorites", () => {
  it("lists favorites with a warning for today's allergies", async () => {
    expect((await listFavorites()).favorites).toEqual([{
      title: "Usual Pasta", meal: "dinner", servings: 4, prep_time: "20 min",
      allergen_warning: "Allergy warning: may contain Nuts. Check every ingredient before cooking. High sodium",
    }]);
  });
});

describe("shoppingListResult", () => {
  it("tells a saved list from one that was built but not stored", () => {
    expect(shoppingListResult({ shoppingList: { items: [], source: "local" } }))
      .toEqual({ status: "saved", items: 0, written_by: "local_fallback", error: null });
    expect(shoppingListResult({ shoppingList: { items: [], source: "ai-unsaved", saveError: "disk" } }))
      .toEqual({ status: "not_saved", items: 0, written_by: "ai", error: "disk" });
  });
});
