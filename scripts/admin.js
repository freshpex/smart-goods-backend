import { readConfig } from "../src/config.js";
import { makeClients } from "../src/supabase.js";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const config = readConfig();
  const { db } = makeClients(config);
  const email = (await rl.question("Existing Supabase Auth admin email: "))
    .trim()
    .toLowerCase();
  if (!email.includes("@")) throw new Error("Enter an email address.");
  let user;
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    user = data.users.find((item) => item.email?.toLowerCase() === email);
    if (user || data.users.length < 100) break;
  }
  if (!user)
    throw new Error(
      "Create this email/password user in Supabase Authentication first, then run this command again.",
    );
  const { data: existing, error: lookupError } = await db
    .from(config.SUPABASE_USERS_TABLE)
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (lookupError)
    throw new Error(
      `Cannot read the users table (${lookupError.code}). Run the migration first.`,
    );
  const result = existing
    ? await db
        .from(config.SUPABASE_USERS_TABLE)
        .update({ store_admin: true, disabled: false })
        .eq("id", user.id)
    : await db
        .from(config.SUPABASE_USERS_TABLE)
        .insert({
          id: user.id,
          email,
          first_name: "Store",
          last_name: "Administrator",
          password_hash: "!supabase-auth-managed",
          store_admin: true,
          disabled: false,
          is_active: true,
          email_verified: true,
        });
  const { error } = result;
  if (error)
    throw new Error(
      `Admin permission could not be saved (${error.code}). Check your users table columns and required existing fields.`,
    );
  console.log(
    "Administrator access enabled. Sign in at /admin/login with the existing Auth password.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
