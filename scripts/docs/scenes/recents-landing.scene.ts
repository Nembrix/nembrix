import { defineScene } from "../helpers";

export default defineScene({
  name: "recents-landing",
  description: "Landing area with one recent connection card and New/Manage buttons.",
  seed: "connection-only",
  async run({ page, shot }) {
    // Wait for the recents card to render — it only appears once
    // listConnections() has resolved (which populates the connections
    // array the RecentsPanel filters against).
    // Wait for either state to render (the recents card OR the empty
    // placeholder). Use locator.or() since we're combining a CSS class
    // with a text match.
    const ready = page.locator(".recents-card").or(page.getByText("No recent connections"));
    await ready.first().waitFor({ timeout: 8000 });
    // If we landed on the empty state, listConnections() probably
    // hadn't resolved yet. Wait a bit more, then re-render is automatic.
    if (await page.getByText("No recent connections").count()) {
      await page.waitForTimeout(2000);
    }
    await shot();
  },
});
