import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const id = "11111111-1111-4111-8111-111111111111";
const config = readConfig({
  NODE_ENV: "test",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key-not-a-secret",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-a-secret",
  FRONTEND_ORIGINS: "http://localhost:5173",
});
function setup({ admin = true, authenticated = true, failDb = false } = {}) {
  const calls = [],
    writes = [];
  const tables = {
    users: [{ id, store_admin: admin, disabled: false, is_active: true }],
    product: [],
    analytic: [],
  };
  const db = {
    auth: {
      getUser: async (token) => ({
        data: {
          user:
            authenticated && token === "verified-token"
              ? { id, email: "admin@example.com" }
              : null,
        },
        error: null,
      }),
      admin: { signOut: async () => ({ error: null }) },
    },
    storage: {
      from: () => ({
        upload: async (path, buffer, options) => {
          writes.push({ path, buffer, options });
          return { error: null };
        },
        getPublicUrl: (path) => ({
          data: {
            publicUrl: `https://example.supabase.co/storage/v1/object/public/product/${path}`,
          },
        }),
      }),
    },
    from(table) {
      let action = "read",
        payload,
        offset = 0,
        end = Infinity,
        single = false;
      const predicates = [];
      const call = { table, methods: [] };
      calls.push(call);
      const query = new Proxy(
        {},
        {
          get(_target, method) {
            if (method === "then")
              return (resolve, reject) => {
                if (failDb)
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: "DB_OFFLINE",
                      message: "private DB details",
                    },
                  }).then(resolve, reject);
                let rows = tables[table].filter((row) =>
                  predicates.every((predicate) => predicate(row)),
                );
                if (action === "insert") {
                  rows = [{ created_at: new Date().toISOString(), ...payload }];
                  tables[table].push(...rows);
                }
                if (action === "upsert") {
                  if (!tables[table].some((row) => row.id === payload.id))
                    tables[table].push(payload);
                  rows = [payload];
                }
                if (action === "update")
                  rows.forEach((row) => Object.assign(row, payload));
                if (action === "delete")
                  tables[table] = tables[table].filter(
                    (row) => !rows.includes(row),
                  );
                const count = rows.length;
                rows = rows.slice(offset, end + 1);
                return Promise.resolve({
                  data: single ? rows[0] || null : rows,
                  count,
                  error: null,
                }).then(resolve, reject);
              };
            return (...args) => {
              call.methods.push([method, ...args]);
              if (["insert", "update", "upsert", "delete"].includes(method)) {
                action = method;
                payload = args[0];
              }
              if (method === "eq")
                predicates.push((row) => row[args[0]] === args[1]);
              if (method === "lte")
                predicates.push((row) => row[args[0]] <= args[1]);
              if (method === "lt")
                predicates.push((row) => row[args[0]] < args[1]);
              if (method === "range") [offset, end] = args;
              if (method === "single" || method === "maybeSingle")
                single = true;
              return query;
            };
          },
        },
      );
      return query;
    },
  };
  const authClient = () => ({
    auth: {
      signInWithPassword: async ({ password }) =>
        password === "correct-test-password"
          ? {
              data: {
                user: { id, email: "admin@example.com" },
                session: {
                  access_token: "verified-token",
                  refresh_token: "refresh",
                  expires_at: 9999999999,
                },
              },
              error: null,
            }
          : { data: {}, error: new Error("wrong") },
      refreshSession: async () => ({
        data: {
          user: { id },
          session: {
            access_token: "verified-token",
            refresh_token: "rotated",
            expires_at: 9999999999,
          },
        },
        error: null,
      }),
    },
  });
  return {
    app: createApp({ config, db, authClient, logger: { error() {} } }),
    tables,
    calls,
    writes,
  };
}
const authorized = (req) => req.set("Authorization", "Bearer verified-token");
const product = { name: "Camera", price: 199, category: "Cameras" };
const event = () => ({
  consent: true,
  eventId: randomUUID(),
  sessionId: randomUUID(),
  path: "/shop",
  language: "en",
  timezone: "Europe/Amsterdam",
  screen: "1280x800",
});

test("health wakes the service without database queries", async () => {
  const s = setup();
  await request(s.app).get("/health").expect(200);
  assert.equal(s.calls.length, 0);
});
test("CORS accepts the configured storefront and rejects another origin", async () => {
  const s = setup();
  const response = await request(s.app)
    .get("/health")
    .set("Origin", "http://localhost:5173")
    .expect(200);
  assert.equal(
    response.headers["access-control-allow-origin"],
    "http://localhost:5173",
  );
  await request(s.app)
    .get("/health")
    .set("Origin", "https://untrusted.example")
    .expect(403);
});
test("all management endpoints require authentication", async () => {
  const s = setup();
  for (const [method, path] of [
    ["get", "/api/admin/products"],
    ["post", "/api/admin/products"],
    ["put", `/api/admin/products/${id}`],
    ["delete", "/api/admin/products"],
    ["delete", `/api/admin/products/${id}`],
    ["post", "/api/admin/images"],
    ["get", "/api/admin/analytics"],
    ["patch", `/api/admin/analytics/${id}`],
    ["delete", "/api/admin/analytics"],
    ["delete", `/api/admin/analytics/${id}`],
  ])
    await request(s.app)[method](path).expect(401);
  assert.equal(s.calls.length, 0);
});
test("a signed-in non-admin cannot read or write private data", async () => {
  const s = setup({ admin: false });
  await authorized(request(s.app).get("/api/admin/analytics")).expect(403);
  await authorized(request(s.app).post("/api/admin/products"))
    .send(product)
    .expect(403);
});
test("an invalid token is verified and rejected", async () => {
  const s = setup();
  await request(s.app)
    .get("/api/admin/products")
    .set("Authorization", "Bearer fabricated-token")
    .expect(401);
  assert.equal(s.calls.length, 0);
});
test("disabled administrators are rejected on the next request", async () => {
  const s = setup();
  s.tables.users[0].disabled = true;
  await authorized(request(s.app).get("/api/auth/me")).expect(403);
});
test("login rejects bad credentials and never returns a session to non-admins", async () => {
  const s = setup();
  await request(s.app)
    .post("/api/auth/login")
    .send({ email: "admin@example.com", password: "wrong" })
    .expect(401);
  const nonAdmin = setup({ admin: false });
  const result = await request(nonAdmin.app)
    .post("/api/auth/login")
    .send({ email: "admin@example.com", password: "correct-test-password" })
    .expect(403);
  assert.equal(result.body.access_token, undefined);
});
test("login and refresh return a verified admin session with no cache", async () => {
  const s = setup();
  const result = await request(s.app)
    .post("/api/auth/login")
    .send({ email: "admin@example.com", password: "correct-test-password" })
    .expect(200);
  assert.equal(result.body.user.role, "admin");
  assert.equal(result.headers["cache-control"], "no-store");
  const refreshed = await request(s.app)
    .post("/api/auth/refresh")
    .send({ refresh_token: "refresh" })
    .expect(200);
  assert.equal(refreshed.body.refresh_token, "rotated");
});
test("public catalog only includes published products and honors pagination", async () => {
  const s = setup();
  for (let i = 0; i < 6; i++)
    s.tables.product.push({
      ...product,
      id: randomUUID(),
      slug: `store-camera-${i}`,
      images: [],
      created_at: "2026-01-01T00:00:00Z",
      published: i !== 5,
    });
  const result = await request(s.app)
    .get("/api/products?page=2&pageSize=2")
    .expect(200);
  assert.equal(result.body.total, 5);
  assert.equal(result.body.items.length, 2);
  assert.equal(result.body.items[0].slug, "store-camera-2");
  assert.equal(result.body.items[0].image, "/product-placeholder.svg");
  assert.equal(result.body.items[0].created_by, undefined);
});
test("product validation requires only name, category and price", async () => {
  const s = setup();
  const result = await authorized(request(s.app).post("/api/admin/products"))
    .send(product)
    .expect(201);
  assert.match(result.body.slug, /^store-camera-/);
  assert.deepEqual(result.body.images, []);
  assert.equal(result.body.description, "");
  for (const input of [
    { ...product, name: "" },
    { ...product, price: -1 },
    { ...product, category: "" },
    { ...product, created_by: id },
  ])
    await authorized(request(s.app).post("/api/admin/products"))
      .send(input)
      .expect(400);
});
test("products cannot embed external or arbitrary bucket image URLs", async () => {
  const s = setup();
  for (const url of [
    "https://evil.example/track.png",
    "https://example.supabase.co/storage/v1/object/public/product/other/file.jpg",
    "javascript:alert(1)",
  ])
    await authorized(request(s.app).post("/api/admin/products"))
      .send({ ...product, images: [url] })
      .expect(400);
});
test("product updates retain identity and can hide a product", async () => {
  const s = setup();
  s.tables.product.push({
    ...product,
    id,
    slug: "store-camera-fixed",
    published: true,
    images: [],
  });
  const result = await authorized(
    request(s.app).put(`/api/admin/products/${id}`),
  )
    .send({ ...product, name: "Updated camera", published: false })
    .expect(200);
  assert.equal(result.body.slug, "store-camera-fixed");
  assert.equal(result.body.published, false);
});
test("clear-all actions require exact confirmation", async () => {
  const s = setup();
  for (const path of ["/api/admin/products", "/api/admin/analytics"]) {
    await authorized(request(s.app).delete(path)).send({}).expect(400);
    await authorized(request(s.app).delete(path))
      .send({ confirm: "yes" })
      .expect(400);
  }
});
test("deletion removes the selected product and returns 404 if absent", async () => {
  const s = setup();
  s.tables.product.push({ ...product, id, images: [], slug: "store-camera" });
  await authorized(request(s.app).delete(`/api/admin/products/${id}`)).expect(
    204,
  );
  await authorized(request(s.app).delete(`/api/admin/products/${id}`)).expect(
    404,
  );
});
test("real image bytes are converted to WebP in the public product bucket", async () => {
  const s = setup();
  const input = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: "#00aa00" },
  })
    .png()
    .toBuffer();
  const result = await authorized(request(s.app).post("/api/admin/images"))
    .attach("image", input, {
      filename: "product.png",
      contentType: "image/png",
    })
    .expect(201);
  assert.match(result.body.url, /\/public\/product\/admin\//);
  const metadata = await sharp(s.writes[0].buffer).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 1800);
  assert.equal(metadata.height, 900);
});
test("invalid image data is rejected without a storage write", async () => {
  const s = setup();
  await authorized(request(s.app).post("/api/admin/images"))
    .attach("image", Buffer.from("not an image"), {
      filename: "photo.png",
      contentType: "image/png",
    })
    .expect(400);
  assert.equal(s.writes.length, 0);
});
test("analytics require explicit consent, ignore DNT/GPC and exclude admin pages", async () => {
  const s = setup();
  const noConsent = event();
  delete noConsent.consent;
  await request(s.app).post("/api/analytics").send(noConsent).expect(400);
  await request(s.app)
    .post("/api/analytics")
    .set("DNT", "1")
    .send(event())
    .expect(204);
  await request(s.app)
    .post("/api/analytics")
    .set("Sec-GPC", "1")
    .send(event())
    .expect(204);
  await request(s.app)
    .post("/api/analytics")
    .send({ ...event(), path: "/admin/login" })
    .expect(204);
  assert.equal(s.tables.analytic.length, 0);
});
test("analytics strip referrer secrets and deduplicate retries by event UUID", async () => {
  const s = setup();
  const input = {
    ...event(),
    referrer: "https://source.example/path?token=secret",
  };
  for (let i = 0; i < 2; i++)
    await request(s.app)
      .post("/api/analytics")
      .set(
        "User-Agent",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      )
      .send(input)
      .expect(204);
  assert.equal(s.tables.analytic.length, 1);
  assert.equal(s.tables.analytic[0].referrer, "https://source.example");
  assert.equal(s.tables.analytic[0].os, "iOS");
});
test("analytics reject query strings and untrusted forwarded IPs are ignored locally", async () => {
  const s = setup();
  await request(s.app)
    .post("/api/analytics")
    .send({ ...event(), path: "/shop?token=secret" })
    .expect(400);
  await request(s.app)
    .post("/api/analytics")
    .set("X-Forwarded-For", "8.8.8.8")
    .send(event())
    .expect(204);
  assert.notEqual(s.tables.analytic[0].ip, "8.8.8.8");
});
test("analytics notes are editable while captured fields cannot be overwritten", async () => {
  const s = setup();
  s.tables.analytic.push({ id, notes: "", path: "/shop" });
  await authorized(request(s.app).patch(`/api/admin/analytics/${id}`))
    .send({ notes: "Follow up" })
    .expect(200);
  assert.equal(s.tables.analytic[0].notes, "Follow up");
  await authorized(request(s.app).patch(`/api/admin/analytics/${id}`))
    .send({ notes: "", ip: "1.2.3.4" })
    .expect(400);
});
test("malformed requests and unavailable databases never expose private errors", async () => {
  const s = setup({ failDb: true });
  const failure = await request(s.app).get("/api/products").expect(503);
  assert.doesNotMatch(JSON.stringify(failure.body), /private DB details/);
  await request(s.app).get("/api/products?page=-1").expect(400);
  await request(s.app)
    .post("/api/auth/login")
    .set("Content-Type", "application/json")
    .send("{")
    .expect(400);
});
