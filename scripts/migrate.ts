/** Apply schema.sql to a PostgreSQL database over TCP. */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required, e.g. DATABASE_URL=postgres://... bun run db:migrate');
  process.exit(1);
}

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const client = new Client({ connectionString: url, application_name: 'buffy-reader-migrate' });

try {
  await client.connect();
  await client.query(schema);
  const { rows } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`,
  );
  console.log(`Schema applied. Tables: ${rows.map((r) => r.table_name).join(', ')}`);
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
