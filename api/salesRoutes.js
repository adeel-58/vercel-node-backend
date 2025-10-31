import express from "express";
import queryDB from "../db.js"; // use stable queryDB
import jwt from "jsonwebtoken";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

// ------------------ Auth Middleware ------------------
const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
      }
      req.user = decoded;
      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error during token verification" });
  }
};

// ------------------ Routes ------------------

// POST /api/sales/add
router.post("/add", verifyToken, async (req, res) => {
  try {
    const {
      product_id,
      quantity,
      sale_price,
      quantity_sold,
      sold_price_per_unit,
      sale_channel,
      notes
    } = req.body;

    const userId = req.user.userId;
    const finalQuantity = quantity || quantity_sold;
    const finalSalePrice = sale_price || sold_price_per_unit;
    const channel = sale_channel || "local";
    const saleNotes = notes || "";

    if (!product_id || !finalQuantity || !finalSalePrice) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields (product_id, quantity, sale_price)"
      });
    }

    // 1️⃣ Get supplier ID linked to logged-in user
    const supplier = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplier.length === 0) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplier[0].id;

    // 2️⃣ Verify product ownership
    const product = await queryDB(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [product_id, supplierId]);
    if (product.length === 0) {
      return res.status(403).json({ success: false, message: "Product not found or unauthorized" });
    }

    const supplierPurchasePrice = parseFloat(product[0].supplier_purchase_price);
    const profit = (finalSalePrice - supplierPurchasePrice) * parseFloat(finalQuantity);
    const totalAmount = finalSalePrice * finalQuantity;

    // 3️⃣ Insert into ProductSales table
    await queryDB(
      `INSERT INTO ProductSales 
        (product_id, quantity_sold, sold_price_per_unit, sale_channel, total_sale_amount, profit, notes, sale_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
      [product_id, finalQuantity, finalSalePrice, channel, totalAmount, profit, saleNotes]
    );

    // 4️⃣ Update product stock
    await queryDB(`UPDATE Product SET stock_quantity = stock_quantity - ? WHERE id = ?`, [finalQuantity, product_id]);

    res.json({
      success: true,
      message: "Sale recorded successfully",
      sale: { product_id, quantity_sold: finalQuantity, sold_price_per_unit: finalSalePrice, sale_channel: channel, total_sale_amount: totalAmount, profit, notes: saleNotes }
    });

  } catch (error) {
    console.error("❌ Error adding sale:", error);
    res.status(500).json({ success: false, message: "Failed to record sale", error: error.message });
  }
});

// GET /api/sales
router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { start_date, end_date } = req.query;

    const supplier = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplier.length === 0) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplier[0].id;

    let query = `
      SELECT ps.*, p.title AS product_title, p.main_image AS product_image
      FROM ProductSales ps
      JOIN Product p ON ps.product_id = p.id
      WHERE p.store_id = ?
    `;
    const params = [supplierId];

    if (start_date && end_date) {
      query += " AND ps.sale_date BETWEEN ? AND ?";
      params.push(start_date, end_date);
    }
    query += " ORDER BY ps.sale_date DESC";

    const sales = await queryDB(query, params);
    res.json({ success: true, sales });

  } catch (error) {
    console.error("❌ Error fetching sales:", error);
    res.status(500).json({ success: false, message: "Failed to fetch sales" });
  }
});

// DELETE /api/sales/:id
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplierRows.length === 0) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplierRows[0].id;

    const sale = await queryDB(
      `SELECT ps.* FROM ProductSales ps JOIN Product p ON ps.product_id = p.id WHERE ps.id = ? AND p.store_id = ?`,
      [id, supplierId]
    );
    if (sale.length === 0) {
      return res.status(404).json({ success: false, message: "Sale not found or unauthorized" });
    }

    await queryDB(`DELETE FROM ProductSales WHERE id = ?`, [id]);
    res.json({ success: true, message: "Sale deleted successfully" });

  } catch (error) {
    console.error("❌ Error deleting sale:", error);
    res.status(500).json({ success: false, message: "Failed to delete sale" });
  }
});

// PUT /api/sales/:id
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity_sold, sold_price_per_unit } = req.body;
    const userId = req.user.userId;

    if (quantity_sold === undefined && sold_price_per_unit === undefined) {
      return res.status(400).json({ success: false, message: "Please provide at least one field to update (quantity or sold price)" });
    }

    const supplier = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplier.length === 0) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplier[0].id;

    const saleData = await queryDB(
      `SELECT ps.*, p.supplier_purchase_price, p.store_id
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE ps.id = ?`,
      [id]
    );
    if (saleData.length === 0) {
      return res.status(404).json({ success: false, message: "Sale record not found" });
    }

    const sale = saleData[0];
    if (sale.store_id !== supplierId) {
      return res.status(403).json({ success: false, message: "Unauthorized: You cannot edit this sale" });
    }

    const newQuantity = quantity_sold !== undefined ? quantity_sold : sale.quantity_sold;
    const newPrice = sold_price_per_unit !== undefined ? sold_price_per_unit : sale.sold_price_per_unit;
    const total_sale_amount = newQuantity * newPrice;
    const profit = (newPrice - sale.supplier_purchase_price) * newQuantity;

    await queryDB(
      `UPDATE ProductSales SET quantity_sold = ?, sold_price_per_unit = ?, total_sale_amount = ?, profit = ? WHERE id = ?`,
      [newQuantity, newPrice, total_sale_amount, profit, id]
    );

    res.json({ success: true, message: "Sale record updated successfully" });

  } catch (error) {
    console.error("❌ Error updating sale:", error);
    res.status(500).json({ success: false, message: "Failed to update sale record" });
  }
});

export default router;
