# Scenes that need a live Postgres connection

These shots can't be scripted without a seeded Postgres database. To
capture them locally:

1. Bring up a Postgres with the seed data of your choice (the project's
   `docker compose` brings up `postgres:16` you can use).
2. Save a connection in the app pointing at it (any name).
3. Connect.
4. Implement the scene file listed below, replacing the placeholder
   stub.
5. `yarn docs:media --only=<scene-name>` to capture.

The seed data shape that the captions assume:

```sql
-- ~3 small tables, one with an FK to another, ~50 rows each.
CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, email text);
CREATE TABLE orders (id serial PRIMARY KEY, user_id int REFERENCES users(id), total numeric, status text);
CREATE TABLE order_items (id serial PRIMARY KEY, order_id int REFERENCES orders(id), sku text, qty int);

INSERT INTO users (name, email) SELECT 'User ' || g, 'user'||g||'@example.com' FROM generate_series(1,50) g;
INSERT INTO orders (user_id, total, status) SELECT (random()*50+1)::int, (random()*1000)::numeric(8,2),
  (ARRAY['pending','paid','shipped','refunded'])[1+(random()*3)::int] FROM generate_series(1,50) g;
INSERT INTO order_items (order_id, sku, qty) SELECT (random()*50+1)::int, 'SKU-' || g, 1+(random()*5)::int FROM generate_series(1,80) g;
```

## Pending scenes

| Scene | Doc page | What to show |
| ---: | --- | --- |
| `activity` | activity.mdx | Activity tab showing `pg_stat_activity` table with a few running sessions |
| `activity-locks` | activity.mdx | Locks panel with a blocker → blocked chain |
| `analysis-hash-join` | analysis.mdx | EXPLAIN ANALYZE output of `SELECT … FROM orders o JOIN users u ON o.user_id=u.id` |
| `architecture` | architecture.mdx | (diagram, hand-drawn — not scriptable) |
| `connection-manager-groups` | groups-recents.mdx | Manage Connections dialog with two groups + Ungrouped |
| `copy-production-warning` | copy-between-connections.mdx | Copy dialog with a `production` env target showing the red banner |
| `edit-cell-context-menu` | editing-data.mdx | Right-click on a cell showing Copy / Edit / Set NULL |
| `edit-pending-banner` | editing-data.mdx | Grid with 3 yellow dirty cells and the "3 pending edits" banner |
| `edit-save-error` | editing-data.mdx | Save error modal with a real PG error message |
| `editor` | editor.mdx | SQL editor with `SELECT * FROM orders WHERE ` and autocomplete dropdown |
| `er-diagram` | er-diagram.mdx | ER view of users / orders / order_items with FK arrows |
| `er-diagram-highlight` | er-diagram.mdx | Same, with `users` clicked → neighbors highlighted |
| `export-dialog` | export.mdx | Export dialog mid-configuration |
| `export-success` | export.mdx | Success modal with Open containing folder |
| `filter-operators` | reference/filter-operators.mdx | Operator dropdown expanded in the filter builder |
| `filters-empty` | filters.mdx | Filter builder expanded with one empty row |
| `import-dialog` | import.mdx | Import dialog with a CSV file selected |
| `import-mapping` | import.mdx | Column mapping table with sample values |
| `inspector` | inspector.mdx | Inspector showing tables/views/functions with one group collapsed |
| `inspector-table-pick` | getting-started.mdx | Inspector with a table about to be clicked |
| `object-ops-dropdown` | object-ops.mdx | "+ New" dropdown open showing 5 options |
| `object-ops-new-table` | object-ops.mdx | New Table dialog with SQL preview |
| `recents-landing` | groups-recents.mdx | Empty-tab landing area with 4-5 recent connection cards |
| `release-notes` | release-notes.mdx | (placeholder page, no live shot needed) |
| `result-grid` | results.mdx | Grid with `orders` data, column summary popover open |
| `roles` | roles.mdx | Roles list view |
| `roles-grant-tree` | roles.mdx | Grant matrix with some checkboxes ticked |
| `schema-diff` | schema-diff.mdx | Schema diff tab showing 2 schemas side-by-side |
| `schema-diff-alter` | schema-diff.mdx | The ALTER statements preview after running diff |
| `structure` | structure.mdx | Structure tab on `orders` showing column list |
| `structure-rename-preview` | structure.mdx | Column rename dialog with SQL preview |
