import mysql from "mysql2/promise";

// Helper function to create connection
async function getConnection() {
  return await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
}

// Wrapper to maintain pool-like interface
const pool = {
  async query(sql, params) {
    const connection = await getConnection();
    try {
      const result = await connection.execute(sql, params);
      await connection.end();
      return result;
    } catch (error) {
      await connection.end();
      throw error;
    }
  }
};

console.log('✅ Database configured (using direct connections)');

export default pool;