// Servidor local sin Netlify CLI: `npm run dev` -> http://localhost:8000
import { createServer } from "node:http";

import { createHandler } from "./app.js";

const port = Number(process.env.PORT ?? 8000);
const handle = createHandler();

createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(incoming.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = !["GET", "HEAD"].includes(incoming.method ?? "GET") && body.length > 0;
  const req = new Request(`http://${incoming.headers.host ?? `localhost:${port}`}${incoming.url}`, {
    method: incoming.method, headers, body: hasBody ? body : undefined,
  });
  const res = await handle(req);
  outgoing.writeHead(res.status, Object.fromEntries(res.headers));
  outgoing.end(Buffer.from(await res.arrayBuffer()));
}).listen(port, () => console.log(`D365 mock en http://localhost:${port}`));
