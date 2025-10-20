// api/analytics.js
import express from "express";
import pool from "../db.js";
import multer from "multer";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const router = express.Router();

// ------------------ Multer setup ------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "uploads/products";
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
export const upload = multer({ storage });

// ------------------ Auth Middleware ------------------
export const verifyToken = (req, res, next) => {
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
      
      console.log("🔐 Decoded JWT Token:", decoded);
      req.user = decoded;
      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error during token verification" });
  }
};

// ------------------ Helper: Get Supplier Profile ID ------------------
async function getSupplierProfileId(userId) {
  const [[profile]] = await pool.query(
    `SELECT id FROM SupplierProfile WHERE user_id = ?`,
    [userId]
  );
  return profile ? profile.id : null;
}

// ------------------ DEBUG: Test Token ------------------
router.get("/test-token", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const supplierId = await getSupplierProfileId(userId);
  
  res.json({
    success: true,
    decoded_user: req.user,
    user_id: userId,
    supplier_profile_id: supplierId,
    message: "Token verified successfully"
  });
});

// ============================
// 1️⃣ Overall Performance KPIs
// ============================
router.get("/kpis", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    console.log("📊 Fetching KPIs for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ 
        success: false, 
        message: "Supplier profile not found. Please complete your supplier setup." 
      });
    }

    console.log("📊 Found supplier_profile_id:", supplierId);

    // Debug: Check if products exist
    const [[productCheck]] = await pool.query(
      `SELECT COUNT(*) as count FROM Product WHERE store_id = ?`,
      [supplierId]
    );
    console.log("Product Count:", productCheck.count);

    // Debug: Check if ProductSales exist
    const [[salesCheck]] = await pool.query(
      `SELECT COUNT(*) as count FROM ProductSales ps 
       JOIN Product p ON ps.product_id = p.id 
       WHERE p.store_id = ?`,
      [supplierId]
    );
    console.log("ProductSales Count:", salesCheck.count);

    const [rows] = await pool.query(
      `SELECT 
         IFNULL(SUM(p.supplier_purchase_price * ps.quantity_sold), 0) AS total_investment,
         IFNULL(SUM(ps.total_sale_amount), 0) AS total_sales_value,
         IFNULL(SUM(ps.profit), 0) AS total_profit,
         IFNULL(ROUND(SUM(ps.profit)/NULLIF(SUM(ps.total_sale_amount),0)*100,2),0) AS profit_margin,
         IFNULL(SUM(p.supplier_purchase_price * p.stock_quantity),0) AS stock_value,
         IFNULL(ROUND(SUM(CASE WHEN p.stock_quantity=0 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0)*100,2),0) AS out_of_stock_percentage
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?`,
      [supplierId]
    );

    console.log("✅ KPIs Result:", rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ KPIs Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 2️⃣ Time-Based Performance
// ============================
router.get("/sales-trend", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { period = "30" } = req.query;

  try {
    console.log("📈 Fetching sales trend for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const [rows] = await pool.query(
      `SELECT 
         DATE(ps.sale_date) AS date,
         SUM(ps.total_sale_amount) AS total_sales,
         SUM(ps.profit) AS total_profit,
         SUM(ps.quantity_sold) AS total_units_sold
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE p.store_id = ? AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(ps.sale_date)
       ORDER BY date ASC`,
      [supplierId, parseInt(period)]
    );

    console.log(`✅ Sales Trend: Found ${rows.length} days of data`);
    res.json(rows);
  } catch (err) {
    console.error("❌ Sales Trend Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 3️⃣ Top Products & Categories
// ============================
router.get("/top-products", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    console.log("🏆 Fetching top products for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    // Top 5 Best-Selling Products by quantity
    const [bestSelling] = await pool.query(
      `SELECT p.id, p.title, IFNULL(SUM(ps.quantity_sold), 0) AS total_quantity
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.id, p.title
       ORDER BY total_quantity DESC
       LIMIT 5`,
      [supplierId]
    );

    // Top 5 Most Profitable Products
    const [mostProfitable] = await pool.query(
      `SELECT p.id, p.title, IFNULL(SUM(ps.profit), 0) AS total_profit
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.id, p.title
       ORDER BY total_profit DESC
       LIMIT 5`,
      [supplierId]
    );

    // Category Contribution
    const [categories] = await pool.query(
      `SELECT 
         COALESCE(p.category, 'Uncategorized') AS category, 
         IFNULL(SUM(ps.total_sale_amount), 0) AS sales_value
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.category
       ORDER BY sales_value DESC`,
      [supplierId]
    );

    console.log(`✅ Top Products: ${bestSelling.length} best-selling, ${categories.length} categories`);
    res.json({ bestSelling, mostProfitable, categories });
  } catch (err) {
    console.error("❌ Top Products Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 4️⃣ Stock & Inventory Analytics
// ============================
router.get("/inventory", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    console.log("📦 Fetching inventory for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const [rows] = await pool.query(
      `SELECT 
         id, title, stock_quantity,
         supplier_purchase_price,
         CASE 
           WHEN stock_quantity = 0 THEN 'Out of Stock'
           WHEN stock_quantity < 5 THEN 'Low Stock'
           ELSE 'In Stock'
         END AS stock_status,
         DATEDIFF(CURDATE(), created_at) AS age_in_days
       FROM Product
       WHERE store_id = ?
       ORDER BY stock_quantity ASC`,
      [supplierId]
    );

    console.log(`✅ Inventory: Found ${rows.length} products`);
    res.json(rows);
  } catch (err) {
    console.error("❌ Inventory Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 5️⃣ Profitability Insights
// ============================
router.get("/profit-insights", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    console.log("💡 Fetching profit insights for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    // Highest Margin Product
    const [highestMargin] = await pool.query(
      `SELECT id, title,
              CASE
                WHEN supplier_sold_price IS NOT NULL AND supplier_sold_price > 0
                THEN ROUND((supplier_sold_price - supplier_purchase_price)/supplier_sold_price*100,2)
                ELSE 0
              END AS margin_percent
       FROM Product
       WHERE store_id = ?
       ORDER BY margin_percent DESC
       LIMIT 1`,
      [supplierId]
    );

    // Products with No Sales
    const [noSales] = await pool.query(
      `SELECT p.id, p.title
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.id, p.title
       HAVING IFNULL(SUM(ps.quantity_sold), 0) = 0`,
      [supplierId]
    );

    console.log(`✅ Profit Insights: ${noSales.length} products with no sales`);
    res.json({ 
      highestMargin: highestMargin[0] || null,
      noSales 
    });
  } catch (err) {
    console.error("❌ Profit Insights Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 6️⃣ Forecasting & Stock Recommendation
// ============================
router.get("/forecast", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const period = parseInt(req.query.period) || 30;

  try {
    console.log("🔮 Fetching forecast for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const [sales] = await pool.query(
      `SELECT p.id, p.title,
              IFNULL(SUM(ps.quantity_sold)/?, 0) AS avg_daily_sold,
              p.stock_quantity
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id 
         AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       WHERE p.store_id = ?
       GROUP BY p.id, p.title, p.stock_quantity`,
      [period, period, supplierId]
    );

    const recommended_stock = sales.map(item => ({
      product_id: item.id,
      title: item.title,
      recommended_quantity: Math.max(0, Math.round(item.avg_daily_sold * period - item.stock_quantity))
    }));

    console.log(`✅ Forecast: Generated for ${sales.length} products`);
    res.json({
      predicted_sales: sales.reduce((sum, s) => sum + s.avg_daily_sold * period, 0),
      predicted_profit: "Use historical profit % * predicted_sales",
      recommended_stock
    });
  } catch (err) {
    console.error("❌ Forecast Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 7️⃣ Alerts & Notifications
// ============================
router.get("/alerts", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    console.log("🚨 Fetching alerts for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    // Low stock < 5
    const [lowStock] = await pool.query(
      `SELECT id, title, stock_quantity 
       FROM Product 
       WHERE store_id = ? AND stock_quantity < 5 AND stock_quantity > 0`,
      [supplierId]
    );

    // Out of stock
    const [outOfStock] = await pool.query(
      `SELECT id, title 
       FROM Product 
       WHERE store_id = ? AND stock_quantity = 0`,
      [supplierId]
    );

    // Aging inventory > 30 days
    const [agingInventory] = await pool.query(
      `SELECT id, title, DATEDIFF(CURDATE(), created_at) AS days_unsold
       FROM Product
       WHERE store_id = ? AND DATEDIFF(CURDATE(), created_at) > 30`,
      [supplierId]
    );

    // High margin products (>40%)
    const [highProfit] = await pool.query(
      `SELECT id, title,
              CASE
                WHEN supplier_sold_price IS NOT NULL AND supplier_sold_price > 0
                THEN ROUND((supplier_sold_price - supplier_purchase_price)/supplier_sold_price*100,2)
                ELSE 0
              END AS margin_percent
       FROM Product
       WHERE store_id = ?
       HAVING margin_percent >= 40`,
      [supplierId]
    );

    console.log(`✅ Alerts: ${lowStock.length} low stock, ${agingInventory.length} aging`);
    res.json({ 
      low_stock: lowStock,
      out_of_stock: outOfStock,
      aging_inventory: agingInventory, 
      high_profit: highProfit 
    });
  } catch (err) {
    console.error("❌ Alerts Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 8️⃣ Sales Heatmap
// ============================
router.get("/heatmap", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const period = parseInt(req.query.period) || 30;

  try {
    console.log("🗓️ Fetching heatmap for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    // Daily sales by weekday
    const [daily] = await pool.query(
      `SELECT DATE_FORMAT(ps.sale_date, '%W') AS day, 
              SUM(ps.total_sale_amount) AS total_sales
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE p.store_id = ? AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY day
       ORDER BY FIELD(day, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')`,
      [supplierId, period]
    );

    // Hourly sales
    const [hourly] = await pool.query(
      `SELECT HOUR(ps.sale_date) AS hour, 
              SUM(ps.total_sale_amount) AS total_sales
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE p.store_id = ? AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY hour
       ORDER BY hour`,
      [supplierId, period]
    );

    console.log(`✅ Heatmap: ${daily.length} days, ${hourly.length} hours`);
    res.json({ daily_sales: daily, hourly_sales: hourly });
  } catch (err) {
    console.error("❌ Heatmap Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 9️⃣ Export / Reporting
// ============================
router.get("/export", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { start, end, type = "json" } = req.query;

  try {
    console.log("📤 Exporting data for user_id:", userId);

    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const [kpis] = await pool.query(
      `SELECT 
         IFNULL(SUM(p.supplier_purchase_price * ps.quantity_sold), 0) AS total_investment,
         IFNULL(SUM(ps.total_sale_amount), 0) AS total_sales_value,
         IFNULL(SUM(ps.profit), 0) AS total_profit
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ? 
         AND ps.sale_date BETWEEN ? AND ?`,
      [supplierId, start, end]
    );

    const [products] = await pool.query(
      `SELECT id, title, stock_quantity, supplier_purchase_price, supplier_sold_price
       FROM Product
       WHERE store_id = ?`,
      [supplierId]
    );

    if (type === "json") {
      console.log("✅ Export completed");
      return res.json({ kpis: kpis[0], products });
    } else {
      return res.status(400).json({ message: "Only JSON export supported now" });
    }
  } catch (err) {
    console.error("❌ Export Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;