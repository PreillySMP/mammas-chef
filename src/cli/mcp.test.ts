// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const log: string[] = [];
vi.mock("./commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands")>()),
  // Each swap logs start/end so overlapping calls would interleave.
  swap: vi.fn(async (plan: string) => {
    log.push(`start ${plan}`);
    await new Promise((r) => setTimeout(r, 20));
    log.push(`end ${plan}`);
    if (plan === "bad") throw new (await import("./commands")).CliError("No plan \"bad\".");
    return { plan_id: plan };
  }),
  makePlan: vi.fn(async () => ({ plan_id: "new" })),
  getProfile: vi.fn(async () => ({ allergies: ["Sesame"] })),
  updateProfile: vi.fn(async (changes: { allergies?: string[] }) => ({ allergies: changes.allergies })),
}));

import { buildServer } from "./mcp";
import { makePlan, updateProfile } from "./commands";

async function connect() {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(server);
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  client.onmessage = (m) => {
    const msg = m as { id?: number };
    if (msg.id !== undefined) pending.get(msg.id)?.(m as Record<string, unknown>);
  };
  await client.start();
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, any>>((resolve) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const i = ++id;
      pending.set(i, resolve);
      void client.send({ jsonrpc: "2.0", id: i, method, params });
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return request;
}

describe("mcp server", () => {
  it("lists the plan tools, with no way to delete a plan", async () => {
    const request = await connect();
    const { result } = await request("tools/list");
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_plan", "swap_meal", "regenerate_day", "get_shopping_list", "check_setup"]));
    expect(names.some((n: string) => n.includes("delete"))).toBe(false);
    const createPlan = result.tools.find((t: { name: string }) => t.name === "create_plan");
    expect(createPlan.description).toMatch(/allergen_warnings to the user word for word/);
    const hints = Object.fromEntries(result.tools.map((t: { name: string; annotations: { destructiveHint: boolean } }) => [t.name, t.annotations.destructiveHint]));
    expect(hints).toMatchObject({ update_profile: true, swap_meal: true, get_profile: false, list_favorites: false });
    // The planner's setup questions, the retry rule and pinning travel with the tool.
    expect(createPlan.description).toMatch(/ask the user what the website's planner asks.*on hand.*saved recipes.*times out, don't call it again/);
    expect(Object.keys(createPlan.inputSchema.properties)).toEqual(expect.arrayContaining(["pinned_recipes", "allow_duplicate"]));
  });

  it("refuses a duplicate week unless the agent passes allow_duplicate", async () => {
    const request = await connect();
    const call = (args: Record<string, unknown>) => request("tools/call", { name: "create_plan", arguments: { request: "next week", ...args } });
    await call({ pinned_recipes: ["Usual Pasta"] });
    expect(makePlan).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: ["Usual Pasta"], refuseDuplicateWeek: true }));
    await call({ allow_duplicate: true });
    expect(makePlan).toHaveBeenLastCalledWith(expect.objectContaining({ refuseDuplicateWeek: false }));
  });

  it("lets an agent add an allergy but never remove one", async () => {
    const request = await connect();
    const call = (args: Record<string, unknown>) => request("tools/call", { name: "update_profile", arguments: args });
    for (const allergies of [[], ["Milk"]]) {
      const { result } = await call({ allergies });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toMatch(/remove Sesame.*done by the user.*mammaschef profile set --allergies/);
    }
    expect((await call({ allergies: ["kiwi"] })).result.content[0].text).toMatch(/Unknown allergy/);
    expect(updateProfile).not.toHaveBeenCalled();

    const added = await call({ allergies: ["sesame", "dairy"] });
    expect(added.result.isError).toBeUndefined();
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({ allergies: ["sesame", "dairy"] }));
    await call({ household: 3 });
    expect(updateProfile).toHaveBeenCalledTimes(2);
  });

  it("runs overlapping tool calls one at a time and reports failures as tool errors", async () => {
    const request = await connect();
    log.length = 0;
    const call = (plan: string) => request("tools/call", { name: "swap_meal", arguments: { plan, day: "Monday", meal: "lunch" } });
    const [a, b] = await Promise.all([call("bad"), call("p2")]);
    expect(log).toEqual(["start bad", "end bad", "start p2", "end p2"]);
    expect(a.result.isError).toBe(true);
    expect(JSON.parse(a.result.content[0].text)).toEqual({ error: "No plan \"bad\"." });
    expect(JSON.parse(b.result.content[0].text)).toEqual({ plan_id: "p2" });
  });
});
