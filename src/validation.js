import { z } from "zod";

export const productSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    price: z.number().finite().min(0).max(100000000),
    stock_quantity: z
      .number()
      .int()
      .min(0)
      .max(100000000)
      .nullable()
      .default(null),
    description: z.string().trim().max(10000).default(""),
    brand: z.string().trim().max(100).default(""),
    availability: z.string().trim().max(200).default(""),
    variants: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    specs: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(100),
            value: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    images: z.array(z.url().max(2000)).max(10).default([]),
    published: z.boolean().default(true),
  })
  .strict();

export const eventSchema = z
  .object({
    consent: z.literal(true),
    eventId: z.uuid(),
    sessionId: z.uuid(),
    path: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)[^?#]*$/),
    referrer: z.string().max(2000).default(""),
    language: z.string().max(50).default(""),
    timezone: z.string().max(100).default(""),
    screen: z
      .string()
      .max(40)
      .regex(/^\d{1,5}x\d{1,5}$/)
      .optional(),
  })
  .strict();

export const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().max(100).default(""),
});

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const error = new Error(
      `Please check: ${result.error.issues.map((i) => i.path.join(".") || "request").join(", ")}.`,
    );
    error.status = 400;
    throw error;
  }
  return result.data;
}

export function publicProduct(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    price: Number(row.price),
    stock_quantity: row.stock_quantity ?? null,
    category: row.category,
    description: row.description || "",
    brand: row.brand || "",
    variants: row.variants || [],
    specs: row.specs || [],
    availability: row.availability || "",
    images: row.images || [],
    image: row.images?.[0] || "/product-placeholder.svg",
    source: "store",
  };
}

export function validateImages(images, config) {
  const prefix = `${config.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/product/admin/`;
  if (
    images.some(
      (image) =>
        !image.startsWith(prefix) ||
        !/^\d{4}\/\d{2}\/[a-f0-9-]+\.webp$/.test(image.slice(prefix.length)),
    )
  ) {
    const error = new Error("Use images uploaded through this product editor.");
    error.status = 400;
    throw error;
  }
}
