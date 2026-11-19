import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const sslRootCertPath = process.env.PGSSLROOTCERT;
const ssl = sslRootCertPath
  ? { ca: readFileSync(resolve(process.cwd(), sslRootCertPath), "utf8") }
  : undefined;
const connectionUrl = new URL(process.env.DATABASE_URL);
if (ssl) {
  for (const parameter of [
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslpassword",
  ]) {
    connectionUrl.searchParams.delete(parameter);
  }
}

export const pool = new Pool({
  connectionString: connectionUrl.toString(),
  ...(ssl ? { ssl } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
