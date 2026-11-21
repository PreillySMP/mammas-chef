// `mammaschef mcp`: a local stdio MCP server exposing the same commands as the CLI.
// stdout carries the protocol, so index.ts has already silenced console output.
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as cmd from "./commands";
import * as stack from "./stack";
import { errorMessage } from "./cli";
import { ALLERGY_OPTIONS } from "@/constants/preferences";

const SAFETY =
  "Show every entry in allergen_warnings to the user word for word, and pass on the notice. " +
  "Never tell the user a meal is safe or allergen-free: the checks are best effort. " +
  "If second_opinion_check is \"off\", mention that only the keyword allergen check ran.";

const LIST =
  "If shopping_list.status is not \"saved\", tell the user the plan was saved but its shopping list was not; get_shopping_list rebuilds it.";

// The website's planner asks these on its setup screen; an agent has to ask them in conversation.
const ASK_FIRST =
  "Before calling, ask the user what the website's planner asks, skipping anything they already told you: " +
  "(1) what they have on hand or want to use up, and any limits such as time (put their answer in request, in their words; on-hand items are read from it); " +
  "(2) which meals to plan and which days to skip (meals, skip_days); " +
  "(3) whether to build the week around any of their saved recipes (find them with list_favorites or search_recipes, then pass pinned_recipes). " +
  "Then tell them which week you are about to plan and call once.";

const PLAN_REF = { type: "string", description: 'A plan_id from list_plans (the first 8 characters are enough), or "latest".' };
const DAY = { type: "string", enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] };
const MEAL = { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] };
const HINT = { type: "string", description: "Optional: what the user wants instead, in their words." };
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  fromJsonSchema({ type: "object", properties, required, additionalProperties: false });

// Tool calls run one at a time: an agent may retry while a call is still running, and
// in-place plan saves aren't atomic, so overlapping edits could duplicate rows.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function respond(fn: () => Promise<unknown>) {
  try {
    const result = await serial(fn);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: errorMessage(e) }) }], isError: true };
  }
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);

export function buildServer() {
  const server = new McpServer({ name: "mammaschef", version: "0.1.0" });
  const tool = (name: string, description: string, schema: ReturnType<typeof object>, run: (a: Args, ctx: ToolCtx) => Promise<unknown>, readOnly = false) =>
    server.registerTool(
      name,
      { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } },
      (args: unknown, ctx: ToolCtx) => respond(() => run((args ?? {}) as Args, ctx)),
    );

  tool("check_setup", "Checks that Mamma's Chef is installed, running and signed in, and says how to fix each problem. Call this first if another tool fails.",
    object({}), () => stack.doctor(), true);

  tool("get_profile", "Returns the household profile the plans are written for: household size, allergies, diet, cuisines, toddler and glucose options, week start. If allergies is empty, ask the user whether anyone in the household has food allergies before creating a plan.",
    object({}), () => cmd.getProfile(), true);

  tool("update_profile", `Changes the household profile. Only include fields the user asked to change. To add an allergy, send every allergy already in the profile (see get_profile) plus the new one. You can't remove an allergy: the user has to do that in a terminal or on the website. The app knows ${ALLERGY_OPTIONS.join(", ")} (common words like "dairy" and "gluten" are mapped).`,
    object({
      household: { type: "integer", minimum: 1, maximum: 20 },
      allergies: { type: "array", items: { type: "string" } },
      diet: { type: "array", items: { type: "string" } },
      cuisines: { type: "array", items: { type: "string" } },
      toddler: { type: "boolean", description: "Make meals toddler-friendly." },
      glucose: { type: "boolean", description: "Make meals glucose-friendly." },
      week_start: { type: "string", enum: ["Sunday", "Monday"] },
    }),
    async (a) => {
      const allergies = a.allergies as string[] | undefined;
      if (allergies) {
        // Like deleting a plan, removing an allergy is kept away from agents: a prompt-injected one could do it unseen.
        const next = cmd.canonicalize(allergies, ALLERGY_OPTIONS, "allergy", cmd.ALLERGY_ALIASES);
        const removed = (await cmd.getProfile()).allergies.filter((x: string) => !next.includes(x));
        if (removed.length) {
          throw new cmd.CliError(`This would remove ${removed.join(", ")} from the allergy list, and nothing was changed. Removing an allergy has to be done by the user: they can run \`mammaschef profile set --allergies ...\` in a terminal or use the website. To add an allergy, send the current list plus the new one.`);
        }
      }
      return cmd.updateProfile({
        household: a.household as number | undefined,
        allergies,
        diet: a.diet as string[] | undefined,
        cuisines: a.cuisines as string[] | undefined,
        toddler: a.toddler as boolean | undefined,
        glucose: a.glucose as boolean | undefined,
        weekStart: str(a, "week_start"),
      });
    });

  tool("create_plan", `Writes and saves a new week of meals with the app's AI, for the household in the saved profile, plus its shopping list: the same planner the website uses. ${ASK_FIRST} Takes about a minute. If the call times out, don't call it again: check list_plans first, because the plan is usually saved. In the result, pinned shows the day each pinned recipe landed on; a null day means the planner left it out. ${LIST} ${SAFETY}`,
    object({
      request: { type: "string", description: "The user's request in their words, e.g. \"plan next week, quick dinners, we have rice and spinach\"." },
      start_date: { type: "string", description: "First day of the week, YYYY-MM-DD. Defaults to the next week start." },
      meals: { type: "array", items: MEAL, description: "Meals to plan each day. Default: breakfast, lunch, dinner." },
      skip_days: { type: "array", items: DAY, description: "Days to leave out." },
      pinned_recipes: { type: "array", items: { type: "string" }, description: "Saved recipes to build the week around: a recipe_id from search_recipes, or a favorite's title from list_favorites." },
      allow_duplicate: { type: "boolean", description: "A week that already has a plan is refused. Set this only after the user confirms they want a second plan for that week." },
    }, ["request"]),
    async (a, ctx) => {
      // Progress every 5 s keeps clients that reset their timeout on progress waiting. A timer,
      // not stream deltas: the model often sends the whole plan in one burst at the end.
      const token = ctx.mcpReq._meta?.progressToken;
      let progress = 0;
      const timer = token === undefined ? undefined : setInterval(() => {
        void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message: "Writing the plan" } }).catch(() => {});
      }, 5000);
      try {
        return await cmd.makePlan({
          request: str(a, "request") ?? "",
          startDate: str(a, "start_date"),
          meals: a.meals as string[] | undefined,
          skipDays: a.skip_days as string[] | undefined,
          pinned: a.pinned_recipes as string[] | undefined,
          refuseDuplicateWeek: a.allow_duplicate !== true,
        });
      } finally {
        clearInterval(timer);
      }
    });

  tool("list_plans", "Lists saved plans, newest first.", object({}), () => cmd.listPlans(), true);

  tool("get_plan", `Returns a saved plan day by day. Set full to include ingredients and steps for cooking. ${SAFETY}`,
    object({ plan: PLAN_REF, full: { type: "boolean" } }, ["plan"]),
    (a) => cmd.showPlan(str(a, "plan") ?? "latest", a.full === true), true);

  tool("swap_meal", `Replaces one meal with a new AI-written one and saves the plan immediately. Leftover meals that came from it are updated too. ${LIST} ${SAFETY}`,
    object({ plan: PLAN_REF, day: DAY, meal: MEAL, hint: HINT }, ["plan", "day", "meal"]),
    (a) => cmd.swap(str(a, "plan")!, str(a, "day")!, str(a, "meal")!, str(a, "hint")));

  tool("regenerate_day", `Replaces all of one day's meals and saves the plan immediately. Also adds a day that is missing from the plan. ${LIST} ${SAFETY}`,
    object({ plan: PLAN_REF, day: DAY, hint: HINT }, ["plan", "day"]),
    (a) => cmd.regen(str(a, "plan")!, str(a, "day")!, str(a, "hint")));

  tool("get_shopping_list", `Returns the plan's shopping list by aisle; on_hand items are ones the user said they have. ${SAFETY}`,
    object({ plan: PLAN_REF }, ["plan"]), (a) => cmd.shopping(str(a, "plan")!), true);

  tool("search_recipes", "Searches the app's recipe library. allergen_warning flags recipes that may conflict with the profile's allergies.",
    object({ query: { type: "string" } }, ["query"]), (a) => cmd.searchRecipes(str(a, "query") ?? ""), true);

  tool("add_recipe_to_plan", `Puts a library recipe (recipe_id from search_recipes) into a plan slot, replacing what's there, and saves immediately. ${LIST} ${SAFETY}`,
    object({ plan: PLAN_REF, day: DAY, meal: MEAL, recipe_id: { type: "string" } }, ["plan", "day", "meal", "recipe_id"]),
    (a) => cmd.addRecipe(str(a, "plan")!, str(a, "day")!, str(a, "meal")!, str(a, "recipe_id")!));

  tool("list_favorites", "Lists the user's favorite recipes. Pass a title to create_plan's pinned_recipes to put it in a new week. allergen_warning flags favorites that may conflict with the profile's allergies; show it to the user word for word.",
    object({}), () => cmd.listFavorites(), true);

  tool("save_favorite", "Saves a meal from a plan to the user's favorites.",
    object({ plan: PLAN_REF, day: DAY, meal: MEAL }, ["plan", "day", "meal"]),
    (a) => cmd.favorite(str(a, "plan")!, str(a, "day")!, str(a, "meal")!));

  return server;
}

type ToolCtx = {
  mcpReq: {
    _meta?: { progressToken?: string | number };
    notify: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
  };
};

export async function serve() {
  await buildServer().connect(new StdioServerTransport());
}
