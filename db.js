// db.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// ✅ Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "your_database_name",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ✅ Test connection once at startup
try {
  const [rows] = await pool.query("SELECT 1 + 1 AS result");
  console.log("✅ Database connected successfully:", rows[0].result);
} catch (error) {
  console.error("❌ Database connection failed:", error.message);
}

export default pool;
