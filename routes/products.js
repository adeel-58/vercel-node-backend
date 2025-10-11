import express from "express";
import db from "../db.js";
const router = express.Router();

// Get all products
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM Product");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new product
router.post("/", async (req, res) => {
  try {
    const { title, supplier_purchase_price, supplier_sold_price, stock_quantity } = req.body;
    const [result] = await db.query(
      `INSERT INTO Product (title, supplier_purchase_price, supplier_sold_price, stock_quantity, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [title, supplier_purchase_price, supplier_sold_price, stock_quantity]
    );
    res.json({ id: result.insertId, message: "Product added" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
