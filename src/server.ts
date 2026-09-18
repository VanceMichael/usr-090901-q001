import { bootstrap, listen } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const { server, db } = bootstrap();

await listen(server, port);
// eslint-disable-next-line no-console
console.log(`[server] 举报分派服务已监听 :${port}（db=${process.env.DB_PATH ?? "data/triage.db"}）`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  // eslint-disable-next-line no-console
  console.log(`[server] 收到 ${signal}，开始优雅关闭`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
