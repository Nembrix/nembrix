import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  // `site` is used for canonical links + sitemap. Defaults to the GitHub
  // Pages URL; override at build time with DOCS_SITE_URL when you have a
  // real domain (e.g. via a CNAME on GitHub Pages).
  site: process.env.DOCS_SITE_URL ?? "https://nembrix.github.io",
  // Served from a project Pages site at /nembrix/, so assets and internal
  // links must carry that prefix. Override with DOCS_BASE (e.g. "/") when
  // serving from a domain root.
  base: process.env.DOCS_BASE ?? "/nembrix",
  // Assets still flow through the pipeline (content-hashed, base-aware URLs
  // — so images resolve under /nembrix and survive a host change), but we
  // skip Sharp-based optimization. Sharp's platform-specific native binary
  // is unreliable under Yarn 1 + --frozen-lockfile in CI; the passthrough
  // service needs no native dep. Screenshots are already reasonably sized.
  image: { service: { entrypoint: "astro/assets/services/noop" } },
  integrations: [
    starlight({
      title: "Nembrix",
      tagline: "Connect. Query. Control.",
      // Header logo — the mark on a white tile so it reads on any header
      // background (the dark docs theme, and the mobile header). Shown
      // alongside the "Nembrix" title.
      logo: { src: "./src/assets/logo.svg" },
      // English default + French. Pages live at content/docs/<slug> (English)
      // and content/docs/fr/<slug> (French). Untranslated FR pages fall back
      // to English, and a language switcher appears in the header.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        fr: { label: "Français", lang: "fr" },
      },
      // Pagefind is bundled by default — searchable static text out of the box.
      // No Algolia signup required.
      customCss: ["./src/styles/custom.css"],
      // Starlight 0.32+ uses an array of link objects (was an object map).
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/nembrix/nembrix",
        },
      ],
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "What it is", link: "/" },
            { label: "How it compares", link: "/comparison/" },
            { label: "Install", link: "/install/" },
            { label: "Your first connection", link: "/getting-started/" },
          ],
        },
        {
          label: "Connections",
          items: [
            { label: "Saving a connection", link: "/connect/" },
            { label: "SSH tunneling", link: "/ssh/" },
            { label: "Groups & recents", link: "/groups-recents/" },
            { label: "Multiple sessions", link: "/sessions/" },
            { label: "Copy between connections", link: "/copy-between-connections/" },
          ],
        },
        {
          label: "Working with data",
          items: [
            { label: "Inspector & tables", link: "/inspector/" },
            { label: "Result grid", link: "/results/" },
            { label: "Editing cells", link: "/editing-data/" },
            { label: "Filters", link: "/filters/" },
            { label: "SQL editor", link: "/editor/" },
            { label: "JavaScript scripting", link: "/scripting/" },
            { label: "Query analysis", link: "/analysis/" },
          ],
        },
        {
          label: "Schema",
          items: [
            { label: "Structure pane", link: "/structure/" },
            { label: "Creating objects", link: "/object-ops/" },
            { label: "Schema diff", link: "/schema-diff/" },
            { label: "ER diagram", link: "/er-diagram/" },
            { label: "Roles & grants", link: "/roles/" },
          ],
        },
        {
          label: "Data movement",
          items: [
            { label: "Export", link: "/export/" },
            { label: "Import", link: "/import/" },
            { label: "Preferences", link: "/reference/preferences/" },
          ],
        },
        {
          label: "Tools",
          items: [
            { label: "Command palette", link: "/palette/" },
            { label: "Server activity", link: "/activity/" },
            { label: "Keyboard shortcuts", link: "/reference/keyboard-shortcuts/" },
            { label: "Filter operators", link: "/reference/filter-operators/" },
          ],
        },
        {
          label: "Under the hood",
          items: [
            { label: "Release notes", link: "/release-notes/" },
          ],
        },
      ],
    }),
  ],
});
