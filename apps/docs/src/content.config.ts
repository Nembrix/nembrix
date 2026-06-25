import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Astro 6+ Content Layer API: collections need an explicit loader. Starlight
// ships `docsLoader()`, a glob loader over src/content/docs/. The config file
// also moved from src/content/config.ts to src/content.config.ts in Starlight
// 0.30+.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
