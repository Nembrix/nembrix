import { defineScene } from "../helpers";

export default defineScene({
  name: "connection-ssh",
  description: "SSH tunneling section of the connection form, expanded.",
  async run({ page, shot }) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+N" : "Control+N");
    await page.waitForSelector("[id='cf-name']", { timeout: 5000 });
    await page.fill("[id='cf-name']", "Acme via Bastion");
    await page.fill("[id='cf-host']", "10.0.1.42");
    await page.fill("[id='cf-user']", "shop");
    await page.fill("[id='cf-database']", "shop");
    // Flip the Use SSH toggle so the section expands.
    await page.click("[id='cf-ssh']");
    await page.fill("[id='cf-ssh-host']", "bastion.acme.example");
    await page.fill("[id='cf-ssh-port']", "22");
    await page.fill("[id='cf-ssh-user']", "ops");
    await page.waitForTimeout(200);
    await shot();
  },
});
