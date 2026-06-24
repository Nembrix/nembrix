CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE orders (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    total_cents BIGINT NOT NULL,
    payload     JSONB,
    placed_at   TIMESTAMPTZ DEFAULT now()
);

INSERT INTO users (email, name) VALUES
    ('alice@example.com', 'Alice'),
    ('bob@example.com',   'Bob'),
    ('carol@example.com', 'Carol');

INSERT INTO orders (user_id, total_cents, payload) VALUES
    (1, 1299, '{"items":["book"]}'),
    (1, 4999, '{"items":["lamp","mug"]}'),
    (2,  799, '{"items":["sticker"]}');
