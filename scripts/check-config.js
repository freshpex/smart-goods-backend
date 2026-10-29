import { readConfig } from "../src/config.js";
import { makeClients } from "../src/supabase.js";

try {
  const config = readConfig();
  const { db } = makeClients(config);
  for (const table of [config.SUPABASE_USERS_TABLE, "product", "analytic"]) {
    const { error } = await db
      .from(table)
      .select(table === "product" ? "id,stock_quantity" : "id")
      .limit(1);
    if (error)
      throw new Error(
        `Cannot access table ${table} (${error.code}). Run the migration/check this project's settings.`,
      );
    console.log(`Table ${table}: accessible`);
  }
  const { data, error } = await db.storage.getBucket("product");
  if (error || !data?.public)
    throw new Error("The product storage bucket must exist and be public.");
  console.log("Public product bucket: accessible");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
