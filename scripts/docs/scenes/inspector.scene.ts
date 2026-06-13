import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "inspector",
  description: "Inspector showing seeded users/orders/order_items + recent_orders view + order_total_for_user function.",
  async run(ctx) {
    await ensureSeedSchemaLoaded(ctx);
    // Let the schema settle (FK badges, sort order, etc.)
    await ctx.page.waitForTimeout(300);
    await ctx.shot();
  },
});
