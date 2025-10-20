import express from "express";
import pool from "../db.js";
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

/**
 * @route   POST /api/sales/add
 * @desc    Add a new product sale
 * @access  Private (Supplier)
 */
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

    // 🧩 Normalize field names (support both old and new keys)
    const finalQuantity = quantity || quantity_sold;
    const finalSalePrice = sale_price || sold_price_per_unit;
    const channel = sale_channel || "local";
    const saleNotes = notes || "";

    // 🧠 Validate required fields
    if (!product_id || !finalQuantity || !finalSalePrice) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields (product_id, quantity, sale_price)"
      });
    }

    // 1️⃣ Get supplier ID linked to logged-in user
    const [supplier] = await pool.query(
      `SELECT id FROM SupplierProfile WHERE user_id = ?`,
      [userId]
    );
    if (supplier.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplier[0].id;

    // 2️⃣ Verify the product actually belongs to this supplier
    const [product] = await pool.query(
      `SELECT * FROM Product WHERE id = ? AND store_id = ?`,
      [product_id, supplierId]
    );

    if (product.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Product not found or unauthorized"
      });
    }

    const productData = product[0];
    const supplierPurchasePrice = parseFloat(productData.supplier_purchase_price);
    const profit =
      (finalSalePrice - supplierPurchasePrice) * parseFloat(finalQuantity);
    const totalAmount = finalSalePrice * finalQuantity;

    // 3️⃣ Insert into ProductSales table
    await pool.query(
      `INSERT INTO ProductSales 
        (product_id, quantity_sold, sold_price_per_unit, sale_channel, total_sale_amount, profit, notes, sale_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
      [
        product_id,
        finalQuantity,
        finalSalePrice,
        channel,
        totalAmount,
        profit,
        saleNotes
      ]
    );

    // 4️⃣ Update product stock
    await pool.query(
      `UPDATE Product SET stock_quantity = stock_quantity - ? WHERE id = ?`,
      [finalQuantity, product_id]
    );

    // ✅ Respond success
    res.json({
      success: true,
      message: "Sale recorded successfully",
      sale: {
        product_id,
        quantity_sold: finalQuantity,
        sold_price_per_unit: finalSalePrice,
        sale_channel: channel,
        total_sale_amount: totalAmount,
        profit,
        notes: saleNotes
      }
    });
  } catch (error) {
    console.error("❌ Error adding sale:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to record sale", error: error.message });
  }
});



/**
 * @route   GET /api/sales
 * @desc    Get all sales for current supplier
 * @access  Private (Supplier)
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { start_date, end_date } = req.query;

    // 1️⃣ Find supplier ID
    const [supplier] = await pool.query(
      `SELECT id FROM SupplierProfile WHERE user_id = ?`,
      [userId]
    );
    if (supplier.length === 0) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplier[0].id;

    // 2️⃣ Build base query
    let query = `
      SELECT ps.*, p.title AS product_title, p.main_image AS product_image
FROM ProductSales ps
JOIN Product p ON ps.product_id = p.id
WHERE p.store_id = ?
`;
    const params = [supplierId];

    // 3️⃣ Apply date filtering if provided
    if (start_date && end_date) {
      query += " AND ps.sale_date BETWEEN ? AND ?";
      params.push(start_date, end_date);
    }

    query += " ORDER BY ps.sale_date DESC";

    // 4️⃣ Execute query
    const [sales] = await pool.query(query, params);

    res.json({ success: true, sales });
  } catch (error) {
    console.error("❌ Error fetching sales:", error);
    res.status(500).json({ success: false, message: "Failed to fetch sales" });
  }
});


/**
 * @route   DELETE /api/sales/:id
 * @desc    Delete a sale record
 * @access  Private (Supplier)
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Get supplier id
    const [supplierRows] = await pool.query(
      `SELECT id FROM SupplierProfile WHERE user_id = ?`,
      [userId]
    );
    if (supplierRows.length === 0) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }
    const supplierId = supplierRows[0].id;

    // Verify the sale belongs to supplier via Product
    const [sale] = await pool.query(
      `SELECT ps.* 
       FROM ProductSales ps 
       JOIN Product p ON ps.product_id = p.id
       WHERE ps.id = ? AND p.store_id = ?`,
      [id, supplierId]
    );

    if (sale.length === 0) {
      return res.status(404).json({ success: false, message: "Sale not found or unauthorized" });
    }

    await pool.query(`DELETE FROM ProductSales WHERE id = ?`, [id]);
    res.json({ success: true, message: "Sale deleted successfully" });
  } catch (error) {
    console.error("❌ Error deleting sale:", error);
    res.status(500).json({ success: false, message: "Failed to delete sale" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params; // sale id
    const { quantity_sold, sold_price_per_unit } = req.body;
    const userId = req.user.userId;

    // 🔹 Step 1: Ensure at least one field is provided
    if (quantity_sold === undefined && sold_price_per_unit === undefined) {
      return res.status(400).json({
        success: false,
        message: "Please provide at least one field to update (quantity or sold price)",
      });
    }

    // 🔹 Step 2: Get supplier id
    const [supplier] = await pool.query(
      `SELECT id FROM SupplierProfile WHERE user_id = ?`,
      [userId]
    );
    if (supplier.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier profile not found",
      });
    }
    const supplierId = supplier[0].id;

    // 🔹 Step 3: Get sale record + product to confirm ownership
    const [saleData] = await pool.query(
      `SELECT ps.*, p.supplier_purchase_price, p.store_id
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE ps.id = ?`,
      [id]
    );

    if (saleData.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Sale record not found",
      });
    }

    const sale = saleData[0];

    // 🔹 Step 4: Check supplier ownership
    if (sale.store_id !== supplierId) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: You cannot edit this sale",
      });
    }

    // 🔹 Step 5: Determine new values
    const newQuantity = quantity_sold !== undefined ? quantity_sold : sale.quantity_sold;
    const newPrice = sold_price_per_unit !== undefined ? sold_price_per_unit : sale.sold_price_per_unit;

    const total_sale_amount = newQuantity * newPrice;
    const profit =
      (newPrice - sale.supplier_purchase_price) * newQuantity;

    // 🔹 Step 6: Update record
    await pool.query(
      `UPDATE ProductSales
       SET quantity_sold = ?, sold_price_per_unit = ?, total_sale_amount = ?, profit = ?
       WHERE id = ?`,
      [newQuantity, newPrice, total_sale_amount, profit, id]
    );

    res.json({
      success: true,
      message: "Sale record updated successfully",
    });
  } catch (error) {
    console.error("❌ Error updating sale:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update sale record",
    });
  }
});

export default router;
