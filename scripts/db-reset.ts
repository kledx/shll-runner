import "dotenv/config";
import pg from "pg";
const { Pool } = pg;

async function main() {
    console.log("Resetting runner database...");

    // Use DATABASE_URL if available, otherwise construct from components
    const connectionString = process.env.DATABASE_URL;
    const config = connectionString
        ? { connectionString }
        : {
            host: process.env.PGHOST,
            port: Number(process.env.PGPORT),
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE,
        };

    const pool = new Pool(config);

    try {
        await pool.query("TRUNCATE TABLE autopilots, runs, token_strategies, market_signals CASCADE;");
        console.log("✅ Database reset successful. Stale data cleared.");
    } catch (err) {
        console.error("❌ Failed to reset database:", err);
    } finally {
        await pool.end();
    }
}

main();
