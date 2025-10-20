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

// ------------------ STORE DASHBOARD API ------------------
router.get("/store", verifyToken, async (req, res) => {
  const userId = req.user.userId; // decoded from token

  try {
    // 🧩 1. Get SupplierProfile and related plan info
    const [[supplier]] = await pool.query(
      `SELECT 
          sp.id AS supplierId,
          sp.plan_id AS planId,
          sp.plan_end,
          COALESCE(p.upload_limit, 0) AS uploadLimit,
          p.name AS planName
        FROM SupplierProfile sp
        LEFT JOIN Plan p ON sp.plan_id = p.id
        WHERE sp.user_id = ?`,
      [userId]
    );

    if (!supplier) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const supplierId = supplier.supplierId;

    // ✅ Default upload limit if no plan assigned (e.g., free plan)
    const uploadLimit = supplier.uploadLimit && supplier.uploadLimit > 0 ? supplier.uploadLimit : 10;

    // 🧩 2. Basic Stats
    const [[productStats]] = await pool.query(
      `SELECT 
          COUNT(*) AS totalProducts,
          SUM(CASE WHEN stock_quantity <= 0 THEN 1 ELSE 0 END) AS outOfStock
        FROM Product
        WHERE store_id = ?`,
      [supplierId]
    );

    const [[salesStats]] = await pool.query(
      `SELECT 
          COALESCE(SUM(total_sale_amount), 0) AS totalSales,
          COALESCE(SUM(profit), 0) AS totalProfit
        FROM ProductSales
        WHERE product_id IN (SELECT id FROM Product WHERE store_id = ?)
        AND MONTH(sale_date) = MONTH(CURDATE())
        AND YEAR(sale_date) = YEAR(CURDATE())`,
      [supplierId]
    );

    const [[inventoryValue]] = await pool.query(
      `SELECT 
          COALESCE(SUM(stock_quantity * supplier_purchase_price), 0) AS remainingInventory
        FROM Product
        WHERE store_id = ?`,
      [supplierId]
    );

    // 🧩 3. Sales Trend (Last 7 days)
    const [salesTrend] = await pool.query(
      `SELECT 
          DATE(sale_date) AS date,
          SUM(total_sale_amount) AS sales
        FROM ProductSales
        WHERE product_id IN (SELECT id FROM Product WHERE store_id = ?)
        AND sale_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY DATE(sale_date)
        ORDER BY date ASC`,
      [supplierId]
    );

    // 🧩 4. Top 5 Best-Selling Products
    const [topProducts] = await pool.query(
      `SELECT 
          p.title AS name,
          SUM(ps.quantity_sold) AS totalSold
        FROM ProductSales ps
        JOIN Product p ON ps.product_id = p.id
        WHERE p.store_id = ?
        GROUP BY ps.product_id
        ORDER BY totalSold DESC
        LIMIT 5`,
      [supplierId]
    );

    // 🧩 5. Stock Overview (for completeness)
    const [[stock]] = await pool.query(
      `SELECT 
          SUM(CASE WHEN stock_quantity > 0 THEN 1 ELSE 0 END) AS inStock,
          SUM(CASE WHEN stock_quantity <= 0 THEN 1 ELSE 0 END) AS outOfStock
        FROM Product
        WHERE store_id = ?`,
      [supplierId]
    );

    // 🧩 6. Recent Activities
    const [recentReviews] = await pool.query(
      `SELECT r.created_at AS date, CONCAT('New review on ', p.title) AS message
        FROM Review r
        JOIN Product p ON r.product_id = p.id
        WHERE p.store_id = ?
        ORDER BY r.created_at DESC
        LIMIT 3`,
      [supplierId]
    );

    const [lowStock] = await pool.query(
      `SELECT title AS product_name, updated_at AS date
        FROM Product
        WHERE store_id = ? AND stock_quantity <= 2
        ORDER BY updated_at DESC
        LIMIT 3`,
      [supplierId]
    );

    const [planExpiry] = await pool.query(
      `SELECT plan_end AS date, 'Your subscription plan is expiring soon' AS message
        FROM SupplierProfile
        WHERE id = ? AND plan_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
        LIMIT 1`,
      [supplierId]
    );

    // Combine all activities
    const activities = [
      ...recentReviews.map(r => ({ message: r.message, date: r.date })),
      ...lowStock.map(l => ({
        message: `Product "${l.product_name}" is running low on stock`,
        date: l.date,
      })),
      ...planExpiry.map(p => ({ message: p.message, date: p.date })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // ✅ FINAL RESPONSE
    return res.json({
      success: true,
      stats: {
        totalProducts: productStats.totalProducts || 0,
        outOfStock: productStats.outOfStock || 0,
        totalSales: salesStats.totalSales || 0,
        totalProfit: salesStats.totalProfit || 0,
        remainingInventory: inventoryValue.remainingInventory || 0,
        uploadLimit, // ✅ Added upload limit (default if missing)
        planName: supplier.planName || "Free Plan",
      },
      charts: {
        salesTrend,
        topProducts,
        stockOverview: [
          { name: "In Stock", value: stock.inStock || 0 },
          { name: "Out of Stock", value: stock.outOfStock || 0 },
        ],
      },
      activities,
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard data",
      error: error.message,
    });
  }
});

export default router;
