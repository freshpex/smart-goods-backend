import { createClient } from "@supabase/supabase-js";

export function makeClients(config) {
  const options = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
  return {
    db: createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      options,
    ),
    // A separate client per auth request avoids sharing login sessions between users.
    authClient: () =>
      createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, options),
  };
}
