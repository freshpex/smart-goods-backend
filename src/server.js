import { readConfig } from "./config.js";
import { makeClients } from "./supabase.js";
import { createApp } from "./app.js";

try {
  const config = readConfig();
  const app = createApp({ config, ...makeClients(config) });
  const server = app.listen(config.PORT, "0.0.0.0", () =>
    console.log(`Smart Goods API listening on port ${config.PORT}`),
  );
  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
