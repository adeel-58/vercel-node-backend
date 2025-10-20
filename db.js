// db.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

// ✅ Create MySQL connection pool (Best for high traffic)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,        // Queue requests if connections are busy
  connectionLimit: 20,            // Allow up to 20 parallel DB connections
  queueLimit: 0,                  // Unlimited request queue
  connectTimeout: 20000,          // Prevent ETIMEDOUT errors
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// ✅ Log successful connection
(async () => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    console.log(`✅ Database connected: ${rows[0].result}`);
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
  }
})();

// ✅ Prevent MySQL idle timeout (important for production)
setInterval(async () => {
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    console.error("⚠️ Keep-alive query failed:", error.message);
  }
}, 60000); // Every 60 seconds

export default pool;
