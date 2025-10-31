// backend/db.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

let pool;

/**
 * Create and return a MySQL connection pool
 * Optimized for Hostinger MySQL + Vercel Serverless
 */
const getPool = () => {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
      waitForConnections: true,
      connectionLimit: 15,
      queueLimit: 0,
      connectTimeout: 15000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      ssl: { rejectUnauthorized: false }, // Hostinger SSL Fix
    });

    console.log("✅ MySQL Pool Initialized");
  }
  return pool;
};

/**
 * Stable Query Helper
 * - Retries on lost connection
 * - Prevents ETIMEDOUT errors
 */
export const queryDB = async (sql, params = []) => {
  const p = getPool();
  try {
    const [rows] = await p.query(sql, params);
    return rows;
  } catch (err) {
    if (
      err.code === "PROTOCOL_CONNECTION_LOST" ||
      err.code === "ECONNRESET" ||
      err.code === "ETIMEDOUT"
    ) {
      console.warn("⚠️ DB connection lost. Reconnecting...");
      pool = null;
      return queryDB(sql, params); // Retry once
    }
    console.error("❌ MySQL Query Error =>", err.message);
    throw err;
  }
};

/**
 * For manual connections (transactions)
 */
export const getConnection = async () => {
  return await getPool().getConnection();
};

/**
 * Prevent idle disconnects with Keep Alive Ping
 */
setInterval(async () => {
  try {
    await queryDB("SELECT 1");
  } catch (err) {
    console.log("⚠️ Keep-alive failed:", err.message);
  }
}, 60000); // Ping every 60 sec

export default queryDB;
