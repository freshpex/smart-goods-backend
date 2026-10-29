import pg from "pg";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required to apply the stock migration.");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
});
try {
  await client.connect();
  await client.query(
    await readFile(
      new URL(
        "../supabase/migrations/202610290002_product_stock.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  console.log(
    "Product stock migration applied. Existing product quantities remain unchanged.",
  );
} catch (error) {
  console.error(
    "Stock migration failed:",
    error.code || "connection unavailable",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
