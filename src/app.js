import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminUser, requireAdmin } from "./auth.js";
import {
  eventSchema,
  pagingSchema,
  parse,
  productSchema,
  publicProduct,
  validateImages,
} from "./validation.js";
import { visitDetails } from "./analytics.js";

const uuidSchema = z.uuid();
function check(result) {
  if (result.error) throw result.error;
  return result;
}

export function createApp({ config, db, authClient, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.origins.includes(origin))
          return callback(null, true);
        const error = new Error("This origin is not allowed.");
        error.status = 403;
        callback(error);
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    }),
  );
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(express.json({ limit: "128kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please try again shortly." },
    }),
  );
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Please wait 15 minutes." },
  });
  app.use("/api/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const input = parse(
      z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(200),
        })
        .strict(),
      req.body,
    );
    const { data, error } = await authClient().auth.signInWithPassword(input);
    if (error || !data.user || !data.session)
      return res.status(401).json({ error: "Email or password is incorrect." });
    const user = await adminUser(db, config, data.user);
    if (!user)
      return res
        .status(403)
        .json({ error: "This account does not have administrator access." });
    res.json({
      user,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  });
  app.post("/api/auth/refresh", authLimit, async (req, res) => {
    const input = parse(
      z.object({ refresh_token: z.string().min(1).max(4096) }).strict(),
      req.body,
    );
    const { data, error } = await authClient().auth.refreshSession(input);
    if (error || !data.session || !data.user)
      return res
        .status(401)
        .json({ error: "Your session has expired. Please sign in again." });
    const user = await adminUser(db, config, data.user);
    if (!user)
      return res
        .status(403)
        .json({ error: "Administrator access is required." });
    res.json({
      user,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  });
  const admin = requireAdmin(db, config);
  app.get("/api/auth/me", admin, (req, res) => res.json({ user: req.admin }));
  app.post("/api/auth/logout", admin, async (req, res) => {
    check(await db.auth.admin.signOut(req.accessToken, "local"));
    res.status(204).end();
  });

  // Public catalog: stable pagination and a high-water mark allow more than 1,000 rows.
  app.get("/api/products", async (req, res) => {
    const { page, pageSize } = parse(pagingSchema, req.query);
    const snapshot = parse(
      z.string().datetime().optional(),
      req.query.snapshot,
    );
    const result = check(
      await db
        .from("product")
        .select("*", { count: "exact" })
        .eq("published", true)
        .lte("created_at", snapshot || new Date().toISOString())
        .order("created_at")
        .order("id")
        .range((page - 1) * pageSize, page * pageSize - 1),
    );
    res
      .set("Cache-Control", "public, max-age=30")
      .json({
        items: result.data.map(publicProduct),
        total: result.count,
        page,
        pageSize,
      });
  });

  let lastPrune = 0;
  app.post(
    "/api/analytics",
    rateLimit({
      windowMs: 60000,
      limit: 40,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    async (req, res) => {
      if (req.headers.dnt === "1" || req.headers["sec-gpc"] === "1")
        return res.status(204).end();
      const event = parse(eventSchema, req.body);
      if (event.path === "/admin" || event.path.startsWith("/admin/"))
        return res.status(204).end();
      check(
        await db
          .from("analytic")
          .upsert(visitDetails(req, event), {
            onConflict: "id",
            ignoreDuplicates: true,
          }),
      );
      if (Date.now() - lastPrune > 3600000) {
        lastPrune = Date.now();
        // Request-bound cleanup also works after Render wakes. Never log visitor data.
        const cutoff = new Date(
          Date.now() - config.ANALYTICS_RETENTION_DAYS * 86400000,
        ).toISOString();
        const result = await db
          .from("analytic")
          .delete()
          .lt("created_at", cutoff);
        if (result.error) logger.error("Analytics retention cleanup failed.");
      }
      res.status(204).end();
    },
  );

  app.use("/api/admin", admin, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/admin/products", async (req, res) => {
    const { page, pageSize, q } = parse(pagingSchema, req.query);
    let query = db.from("product").select("*", { count: "exact" });
    if (q) query = query.ilike("name", `%${q.replace(/[%_\\]/g, "\\$&")}%`);
    const result = check(
      await query
        .order("created_at", { ascending: false })
        .order("id")
        .range((page - 1) * pageSize, page * pageSize - 1),
    );
    res.json({
      items: result.data.map((row) => ({
        ...publicProduct(row),
        published: row.published,
        created_at: row.created_at,
      })),
      total: result.count,
      page,
      pageSize,
    });
  });
  app.post("/api/admin/products", async (req, res) => {
    const input = parse(productSchema, req.body);
    validateImages(input.images, config);
    const id = randomUUID();
    const slug = `store-${
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06ff]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "product"
    }-${id.slice(0, 8)}`;
    const result = check(
      await db
        .from("product")
        .insert({ ...input, id, slug, created_by: req.admin.id })
        .select()
        .single(),
    );
    res
      .status(201)
      .json({
        ...publicProduct(result.data),
        published: result.data.published,
      });
  });
  app.put("/api/admin/products/:id", async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const input = parse(productSchema, req.body);
    validateImages(input.images, config);
    const result = check(
      await db
        .from("product")
        .update({ ...input, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .maybeSingle(),
    );
    if (!result.data)
      return res.status(404).json({ error: "Product not found." });
    res.json({
      ...publicProduct(result.data),
      published: result.data.published,
    });
  });
  app.delete("/api/admin/products", async (req, res) => {
    parse(
      z.object({ confirm: z.literal("DELETE ALL ADDED PRODUCTS") }).strict(),
      req.body,
    );
    check(await db.from("product").delete().not("id", "is", null));
    res.status(204).end();
  });
  app.delete("/api/admin/products/:id", async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const result = check(
      await db.from("product").delete().eq("id", id).select("id"),
    );
    if (!result.data.length)
      return res.status(404).json({ error: "Product not found." });
    res.status(204).end();
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter(_req, file, callback) {
      if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype))
        callback(null, true);
      else {
        const error = new Error("Upload a JPEG, PNG or WebP image.");
        error.status = 400;
        callback(error);
      }
    },
  });
  app.post("/api/admin/images", upload.single("image"), async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "Choose an image to upload." });
    let buffer;
    try {
      buffer = await sharp(req.file.buffer, {
        limitInputPixels: 40000000,
        animated: false,
      })
        .rotate()
        .resize({
          width: 1800,
          height: 1800,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 88 })
        .toBuffer();
    } catch {
      return res
        .status(400)
        .json({
          error:
            "This image cannot be read. Use a JPEG, PNG or WebP up to 40 megapixels.",
        });
    }
    const date = new Date();
    const path = `admin/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.webp`;
    check(
      await db.storage
        .from("product")
        .upload(path, buffer, {
          contentType: "image/webp",
          cacheControl: "31536000",
          upsert: false,
        }),
    );
    const { data } = db.storage.from("product").getPublicUrl(path);
    res.status(201).json({ url: data.publicUrl, path });
  });
  app.get("/api/admin/analytics", async (req, res) => {
    const { page, pageSize, q } = parse(pagingSchema, req.query);
    let query = db.from("analytic").select("*", { count: "exact" });
    // Fixed fields and stripped filter syntax prevent PostgREST filter injection.
    const search = q.replace(/[^\p{L}\p{N} .:/@-]/gu, "").trim();
    if (search)
      query = query.or(
        ["path", "country", "city", "device", "browser", "notes"]
          .map((field) => `${field}.ilike.%${search}%`)
          .join(","),
      );
    const result = check(
      await query
        .order("created_at", { ascending: false })
        .order("id")
        .range((page - 1) * pageSize, page * pageSize - 1),
    );
    res.json({ items: result.data, total: result.count, page, pageSize });
  });
  app.patch("/api/admin/analytics/:id", async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const input = parse(
      z.object({ notes: z.string().trim().max(2000) }).strict(),
      req.body,
    );
    const result = check(
      await db
        .from("analytic")
        .update(input)
        .eq("id", id)
        .select()
        .maybeSingle(),
    );
    if (!result.data)
      return res.status(404).json({ error: "Visit not found." });
    res.json(result.data);
  });
  app.delete("/api/admin/analytics", async (req, res) => {
    parse(
      z.object({ confirm: z.literal("DELETE ALL ANALYTICS") }).strict(),
      req.body,
    );
    check(await db.from("analytic").delete().not("id", "is", null));
    res.status(204).end();
  });
  app.delete("/api/admin/analytics/:id", async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const result = check(
      await db.from("analytic").delete().eq("id", id).select("id"),
    );
    if (!result.data.length)
      return res.status(404).json({ error: "Visit not found." });
    res.status(204).end();
  });
  app.use((_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError)
      return res
        .status(400)
        .json({
          error:
            error.code === "LIMIT_FILE_SIZE"
              ? "Images must be 10 MB or smaller."
              : "Upload one image at a time.",
        });
    const status =
      error.status || (error.type === "entity.parse.failed" ? 400 : 503);
    if (status >= 500)
      logger.error("API request failed", { code: error.code || "unavailable" });
    res
      .status(status)
      .json({
        error:
          status >= 500
            ? "The service is temporarily unavailable. Please try again."
            : error.message,
      });
  });
  return app;
}
