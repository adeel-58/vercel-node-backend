import express from "express";
import db from "../db.js";
const router = express.Router();

// Add a sale and update profit
router.post("/", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { product_id, quantity_sold, sold_price_per_unit } = req.body;
    const [pRows] = await conn.query("SELECT supplier_purchase_price, stock_quantity FROM Product WHERE id = ?", [product_id]);
    if (!pRows.length) throw new Error("Product not found");

    const product = pRows[0];
    if (product.stock_quantity < quantity_sold) throw new Error("Insufficient stock");

    const profit = (sold_price_per_unit - product.supplier_purchase_price) * quantity_sold;

    await conn.query(
      `INSERT INTO ProductSales (product_id, quantity_sold, sold_price_per_unit, total_sale_amount, profit, sale_date, created_at)
       VALUES (?, ?, ?, ?, ?, CURDATE(), NOW())`,
      [product_id, quantity_sold, sold_price_per_unit, sold_price_per_unit * quantity_sold, profit]
    );

    await conn.query("UPDATE Product SET stock_quantity = stock_quantity - ? WHERE id = ?", [quantity_sold, product_id]);

    await conn.commit();
    res.json({ message: "Sale recorded successfully", profit });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

export default router;
