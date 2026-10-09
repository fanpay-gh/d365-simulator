import { getStore } from "@netlify/blobs";

import { createHandler } from "../../src/app.js";
import type { Persistence, State } from "../../src/store.js";

// Las instancias de la función no comparten memoria (ni siquiera entre dos requests seguidos),
// así que registros, log y config se guardan en Netlify Blobs y se rehidratan en cada request.
// Es last-writer-wins: suficiente para un mock, no para concurrencia alta.
const blobs = () => getStore("d365-mock");
const persistence: Persistence = {
  load: async () => (await blobs().get("state", { type: "json" })) as State | null,
  save: async (state) => { await blobs().setJSON("state", state); },
};

const handle = createHandler(undefined, undefined, persistence);

export default async (req: Request): Promise<Response> => handle(req);

export const config = {
  path: ["/:tenant/oauth2/v2.0/token", "/api/data/*", "/_mock", "/_mock/*"],
};
