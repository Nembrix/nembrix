-- Seed data for docs media capture.
--
-- Small, realistic, FK-linked. The shapes are what the doc captions
-- assume (see scripts/docs/scenes/_TODO-db-dependent.md). Keep tables
-- small enough that screenshots stay readable.

CREATE TABLE users (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  email text UNIQUE NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id      serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  total   numeric(10,2) NOT NULL,
  status  text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_idx ON orders(user_id);
CREATE INDEX orders_status_idx ON orders(status);

CREATE TABLE order_items (
  id       serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  sku      text NOT NULL,
  qty      int NOT NULL CHECK (qty > 0),
  price    numeric(10,2) NOT NULL
);

CREATE INDEX order_items_order_idx ON order_items(order_id);

-- Seed rows. setseed makes the random selections deterministic so a
-- given screenshot looks the same on every machine.
SELECT setseed(0.42);

INSERT INTO users (name, email)
SELECT 'User ' || g, 'user' || g || '@example.com'
FROM generate_series(1, 50) g;

INSERT INTO orders (user_id, total, status)
SELECT
  (random() * 49 + 1)::int,
  (random() * 1000)::numeric(10,2),
  (ARRAY['pending','paid','shipped','refunded'])[1 + (random() * 3)::int]
FROM generate_series(1, 80) g;

INSERT INTO order_items (order_id, sku, qty, price)
SELECT
  (random() * 79 + 1)::int,
  'SKU-' || (1000 + g),
  1 + (random() * 5)::int,
  (random() * 100)::numeric(10,2)
FROM generate_series(1, 200) g;

-- Plain VIEW so the inspector has something under "Views".
CREATE VIEW recent_orders AS
  SELECT o.id, u.name AS customer, o.total, o.status, o.created_at
  FROM orders o JOIN users u ON u.id = o.user_id
  WHERE o.created_at > now() - interval '30 days';

-- A user-defined function so the Functions group isn't empty.
CREATE FUNCTION order_total_for_user(uid int) RETURNS numeric
LANGUAGE sql AS $$
  SELECT COALESCE(SUM(total), 0) FROM orders WHERE user_id = uid
$$;
