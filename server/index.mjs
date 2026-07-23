import { pathToFileURL } from "node:url";

import { createTaskboardServer, resolvePort } from "./app.mjs";

export { createTaskboardServer, resolvePort, resolveServerOptions } from "./app.mjs";

async function main() {
  const app = createTaskboardServer();
  const address = await app.listen({ port: resolvePort() });
  console.log(`Codex Taskboard listening on http://127.0.0.1:${address.port}`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
