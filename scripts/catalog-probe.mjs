// Hand run only (never in tests or the build). Usage:
//   node scripts/catalog-probe.mjs <outfile.json> <method> [tool] [argsJson]
// One call per run, raw JSON-RPC answer saved with the tool, arguments and time.
// No headers or cookies are saved. Wait 2 seconds or more between runs.
import { writeFileSync } from "node:fs";

if (process.env.NODE_ENV === "production") {
  console.error("catalog-probe is a hand tool for development only. It does not run in production.");
  process.exit(1);
}

const [out, method, tool, argsJson] = process.argv.slice(2);
const params = method === "tools/call" ? { name: tool, arguments: JSON.parse(argsJson ?? "{}") } : {};
const started = Date.now();
const res = await fetch("https://mycardfolio.com/api/mcp", {
  method: "POST",
  redirect: "manual",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "CardVault/0.1.0",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});
const text = await res.text();
const elapsed = Date.now() - started;
const line = text.split("\n").find((l) => l.startsWith("data:"));
const response = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
writeFileSync(
  out,
  JSON.stringify(
    {
      note: "Recorded " + new Date().toISOString().slice(0, 10) + " from https://mycardfolio.com/api/mcp (" + method + "). Public card data only.",
      tool: tool ?? method,
      arguments: params.arguments ?? {},
      elapsed_ms: elapsed,
      status: res.status,
      bytes: text.length,
      response,
    },
    null,
    1,
  ),
);
console.log(res.status, text.length, "bytes", elapsed, "ms");
