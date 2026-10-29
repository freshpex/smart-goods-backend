import { z } from "zod";

export function readConfig(env = process.env) {
  const schema = z.object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(20),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    SUPABASE_STORAGE_BUCKET: z.literal("product").default("product"),
    SUPABASE_USERS_TABLE: z.enum(["users", "user"]).default("users"),
    FRONTEND_ORIGINS: z
      .string()
      .min(1)
      .default("http://localhost:5173,http://127.0.0.1:5173"),
    TRUST_PROXY: z.coerce.number().int().min(0).max(3).default(0),
    ANALYTICS_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(90),
  });
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Missing or invalid environment settings: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const config = result.data;
  if (config.NODE_ENV === "production" && !env.FRONTEND_ORIGINS)
    throw new Error("FRONTEND_ORIGINS is required in production.");
  config.origins = config.FRONTEND_ORIGINS.split(",").map((s) => s.trim());
  for (const origin of config.origins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (config.NODE_ENV === "production" && url.protocol !== "https:")
    ) {
      throw new Error(
        "FRONTEND_ORIGINS must contain exact origins (HTTPS in production).",
      );
    }
  }
  return config;
}
