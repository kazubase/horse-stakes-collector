import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

async function runMigration() {
  try {
    console.log("⏳ Running migrations...");
    
    await migrate(db, {
      migrationsFolder: "./db/migrations",
    });
    
    console.log("✅ Migrations completed");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
  process.exit(0);
}

runMigration();