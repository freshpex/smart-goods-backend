import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { readConfig } from "../src/config.js";
import { makeClients } from "../src/supabase.js";

const base = process.env.SMOKE_API_URL || "http://localhost:4000";
const email = process.env.SMOKE_ADMIN_EMAIL,
  password = process.env.SMOKE_ADMIN_PASSWORD;
if (!email || !password)
  throw new Error(
    "Set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD temporarily to run the live checks.",
  );
const { db } = makeClients(readConfig());
let token = "",
  productId = "",
  imagePath = "",
  refreshToken = "";
const visitId = randomUUID();
async function call(
  path,
  { method = "GET", data, form, authenticated = true, status = 200 } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: form || (data ? JSON.stringify(data) : undefined),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${result?.error || response.status}`,
  );
  return result;
}
try {
  await call("/health");
  const session = await call("/api/auth/login", {
    method: "POST",
    data: { email, password },
  });
  token = session.access_token;
  refreshToken = session.refresh_token;
  assert.equal(session.user.role, "admin");
  await call("/api/auth/me");
  await call("/api/admin/analytics", { authenticated: false, status: 401 });
  console.log(
    "Live login, verified admin session and unauthorized-access rejection: passed",
  );
  const image = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "#173e32" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set(
    "image",
    new Blob([image], { type: "image/png" }),
    "verification.png",
  );
  const upload = await call("/api/admin/images", {
    method: "POST",
    form,
    status: 201,
  });
  imagePath = upload.path;
  const publicImage = await fetch(upload.url);
  assert.equal(publicImage.status, 200);
  assert.match(publicImage.headers.get("content-type"), /image\/webp/);
  console.log(
    "Live storage upload and anonymous public image download: passed",
  );
  const payload = {
    name: `API verification ${randomUUID()}`,
    category: "Verification",
    price: 1,
    published: false,
    images: [upload.url],
    variants: ["Black", "Custom colour"],
    specs: [{ label: "Material", value: "Aluminium" }],
  };
  const added = await call("/api/admin/products", {
    method: "POST",
    data: payload,
    status: 201,
  });
  productId = added.id;
  assert.equal(added.images[0], upload.url);
  const updated = await call(`/api/admin/products/${productId}`, {
    method: "PUT",
    data: {
      ...payload,
      name: `${payload.name} edited`,
      description: "Temporary verification record",
    },
  });
  assert.equal(updated.description, "Temporary verification record");
  const listed = await call(
    "/api/admin/products?page=1&pageSize=1&q=API%20verification",
  );
  assert.ok(listed.total >= 1);
  assert.equal(listed.items.length, 1);
  const publicCatalog = await call("/api/products?page=1&pageSize=100", {
    authenticated: false,
  });
  assert.ok(!publicCatalog.items.some((item) => item.id === productId));
  console.log(
    "Live product create/edit/list pagination and hidden-product exclusion: passed",
  );
  await call("/api/analytics", {
    method: "POST",
    authenticated: false,
    status: 204,
    data: {
      consent: true,
      eventId: visitId,
      sessionId: randomUUID(),
      path: "/verification",
      language: "en",
      timezone: "Europe/Amsterdam",
      screen: "1280x800",
    },
  });
  await call(`/api/admin/analytics/${visitId}`, {
    method: "PATCH",
    data: { notes: "Temporary verification record" },
  });
  const visits = await call(
    "/api/admin/analytics?page=1&pageSize=1&q=verification",
  );
  assert.ok(visits.total >= 1);
  assert.equal(visits.items.length, 1);
  console.log(
    "Live visitor ingestion, details, editable notes and pagination: passed",
  );
  const refreshed = await call("/api/auth/refresh", {
    method: "POST",
    data: { refresh_token: refreshToken },
  });
  token = refreshed.access_token;
  await call("/api/auth/me");
  await call(`/api/admin/products/${productId}`, {
    method: "DELETE",
    status: 204,
  });
  productId = "";
  await call(`/api/admin/analytics/${visitId}`, {
    method: "DELETE",
    status: 204,
  });
  console.log("Live session refresh and exact-record deletion: passed");
} finally {
  if (productId) {
    const { error } = await db.from("product").delete().eq("id", productId);
    assert.ifError(error);
  }
  const { error } = await db.from("analytic").delete().eq("id", visitId);
  assert.ifError(error);
  if (imagePath) {
    const { error } = await db.storage.from("product").remove([imagePath]);
    assert.ifError(error);
  }
  if (token) await call("/api/auth/logout", { method: "POST", status: 204 });
  console.log("Temporary verification data cleaned up.");
}
