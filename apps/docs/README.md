# Nembrix docs

End-user documentation — an [Astro Starlight](https://starlight.astro.build/)
static site. Content lives in `src/content/docs/*.mdx`.

## Local

```sh
yarn docs:dev      # dev server with hot reload
yarn docs:build    # production build → dist/ (what CI runs)
```

## Deployment

Built and deployed to **GitHub Pages** by `.github/workflows/docs.yml`
on every push touching `apps/docs/**`. The site serves from the project
Pages URL: <https://oesukam.github.io/nembrix/>.

Because that's a *project* site (served under `/nembrix/`, not a domain
root), `astro.config.mjs` sets `base: "/nembrix"` so asset and internal
link URLs carry the prefix. Both the base and the canonical site URL are
env-overridable:

| Var | Default | Purpose |
| --- | --- | --- |
| `DOCS_BASE` | `/nembrix` | URL path prefix the site is served from |
| `DOCS_SITE_URL` | `https://oesukam.github.io` | Canonical origin for links + sitemap |

### Moving to a custom domain

If you ever serve the docs from a domain root (e.g.
`docs.nembrix.dev` via a CNAME), build with the base set to `/` and the
site set to the domain — **no code change needed**:

```sh
DOCS_BASE=/ DOCS_SITE_URL=https://docs.nembrix.dev yarn docs:build
```

(Or set those as env vars on the `Build docs` step in `docs.yml`.)
