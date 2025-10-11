import 'dotenv/config';
import mysql from 'mysql2/promise';

async function testConnection() {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    });
    console.log('✅ Connected successfully to Hostinger MySQL!');
    await conn.end();
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
  }
}

testConnection();
