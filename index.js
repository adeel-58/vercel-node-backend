import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ✅ 1. Test endpoint
app.get("/api/test-db", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ success: true, message: "Database connected!", result: rows[0].result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Database connection failed", error: error.message });
  }
});

// ✅ 2. Get all products
app.get("/api/products", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM Product");
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3. Get a specific product by ID
app.get("/api/products/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM Product WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: "Product not found" });
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 4. Add new product
app.post("/api/products", async (req, res) => {
  const { store_id, title, supplier_price, stock_quantity, category } = req.body;
  try {
    const [result] = await pool.query(
      "INSERT INTO Product (store_id, title, supplier_price, stock_quantity, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())",
      [store_id, title, supplier_price, stock_quantity, category]
    );
    res.json({ success: true, message: "Product added successfully", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 5. Update a product
app.put("/api/products/:id", async (req, res) => {
  const { title, supplier_price, stock_quantity, category, status } = req.body;
  try {
    const [result] = await pool.query(
      "UPDATE Product SET title=?, supplier_price=?, stock_quantity=?, category=?, status=?, updated_at=NOW() WHERE id=?",
      [title, supplier_price, stock_quantity, category, status, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    res.json({ success: true, message: "Product updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 6. Delete a product
app.delete("/api/products/:id", async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM Product WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    res.json({ success: true, message: "Product deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
