/**
 * Deploy-time schema preflight.
 *
 *   npm run check:schema
 *
 * Exits 0 when the database has everything this build needs, 1 with the list of
 * gaps when it does not. Run it after deploying and before pointing traffic at
 * the new build — a missing migration is otherwise invisible until a user hits
 * the page that reads the missing column.
 *
 * Needs SUPABASE_URL and the service-role key in the environment, the same as
 * the server does.
 */
import { describeSchemaProblems, findSchemaProblems } from "../src/lib/schema-check.server";

const problems = await findSchemaProblems();

if (problems.length === 0) {
  console.log("Schema check passed: the database has every table and column this build needs.");
  process.exit(0);
}

console.error(describeSchemaProblems(problems));
process.exit(1);
