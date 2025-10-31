// api/analytics.js
import express from "express";
import queryDB from "../db.js"; // use stable queryDB
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
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
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
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return res.status(401).json({ success: false, message: "No token provided" });

    const token = authHeader.split(" ")[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) return res.status(401).json({ success: false, message: "Invalid or expired token" });
      req.user = decoded;
      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error during token verification" });
  }
};

// ------------------ Helper: Get Supplier Profile ID ------------------
async function getSupplierProfileId(userId) {
  const rows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
  return rows[0]?.id || null;
}

// ------------------ Test Token ------------------
router.get("/test-token", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const supplierId = await getSupplierProfileId(userId);
  res.json({ success: true, decoded_user: req.user, user_id: userId, supplier_profile_id: supplierId });
});

// ============================
// 1️⃣ Overall KPIs
// ============================
router.get("/kpis", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) 
      return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const rows = await queryDB(
      `SELECT 
        IFNULL(SUM(p.supplier_purchase_price * ps.quantity_sold), 0) AS total_investment,
        IFNULL(SUM(ps.total_sale_amount), 0) AS total_sales_value,
        IFNULL(SUM(ps.profit), 0) AS total_profit,
        IFNULL(ROUND(SUM(ps.profit)/NULLIF(SUM(ps.total_sale_amount),0)*100,2),0) AS profit_margin,
        IFNULL(SUM(p.supplier_purchase_price * p.stock_quantity),0) AS stock_value,
        IFNULL(ROUND(SUM(CASE WHEN p.stock_quantity=0 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0)*100,2),0) AS out_of_stock_percentage
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       WHERE p.store_id = ?`,
      [supplierId]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


// ============================
// 2️⃣ Sales Trend
// ============================
router.get("/sales-trend", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const period = parseInt(req.query.period) || 30;

  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const rows = await queryDB(
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
      [supplierId, period]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 3️⃣ Top Products & Categories
// ============================
router.get("/top-products", verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const bestSelling = await queryDB(
      `SELECT p.id, p.title, IFNULL(SUM(ps.quantity_sold), 0) AS total_quantity
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.id, p.title
       ORDER BY total_quantity DESC
       LIMIT 5`,
      [supplierId]
    );

    const mostProfitable = await queryDB(
      `SELECT p.id, p.title, IFNULL(SUM(ps.profit), 0) AS total_profit
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.id, p.title
       ORDER BY total_profit DESC
       LIMIT 5`,
      [supplierId]
    );

    const categories = await queryDB(
      `SELECT COALESCE(p.category, 'Uncategorized') AS category, 
              IFNULL(SUM(ps.total_sale_amount), 0) AS sales_value
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.category
       ORDER BY sales_value DESC`,
      [supplierId]
    );

    res.json({ bestSelling, mostProfitable, categories });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 4️⃣ Inventory
// ============================
router.get("/inventory", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const rows = await queryDB(
      `SELECT id, title, stock_quantity,
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

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 5️⃣ Profit Insights
// ============================
router.get("/profit-insights", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) {
      return res.status(404).json({
        success: false,
        message: "Supplier profile not found"
      });
    }

    // ✅ Highest profit margin product with main image
    const highestMargin = await queryDB(
      `SELECT id, title, main_image,
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

    // ✅ Products with no sales + main images
    const noSales = await queryDB(
      `SELECT p.id, p.title, p.main_image
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ?
       GROUP BY p.id, p.title, p.main_image
       HAVING IFNULL(SUM(ps.quantity_sold), 0) = 0`,
      [supplierId]
    );

    res.json({
      highestMargin: highestMargin[0] || null,
      noSales
    });

  } catch (err) {
    res.status(500).json({
      message: "Server error",
      error: err.message
    });
  }
});


// ============================
// 6️⃣ Forecast & Recommended Stock
// ============================
router.get("/forecast", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const period = parseInt(req.query.period) || 30;
  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const sales = await queryDB(
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

    res.json({
      predicted_sales: sales.reduce((sum, s) => sum + s.avg_daily_sold * period, 0),
      predicted_profit: "Use historical profit % * predicted_sales",
      recommended_stock
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================
// 7️⃣ Alerts
// ============================
router.get("/alerts", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const lowStock = await queryDB(`SELECT id, title, stock_quantity FROM Product WHERE store_id = ? AND stock_quantity < 5 AND stock_quantity > 0`, [supplierId]);
    const outOfStock = await queryDB(`SELECT id, title FROM Product WHERE store_id = ? AND stock_quantity = 0`, [supplierId]);
    const agingInventory = await queryDB(`SELECT id, title, DATEDIFF(CURDATE(), created_at) AS days_unsold FROM Product WHERE store_id = ? AND DATEDIFF(CURDATE(), created_at) > 30`, [supplierId]);
    const highProfit = await queryDB(`SELECT id, title, ROUND((supplier_sold_price - supplier_purchase_price)/supplier_sold_price*100,2) AS margin_percent FROM Product WHERE store_id = ? HAVING margin_percent >= 40`, [supplierId]);

    res.json({ low_stock: lowStock, out_of_stock: outOfStock, aging_inventory: agingInventory, high_profit: highProfit });
  } catch (err) {
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
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const daily = await queryDB(
      `SELECT DATE_FORMAT(ps.sale_date, '%W') AS day, SUM(ps.total_sale_amount) AS total_sales
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE p.store_id = ? AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY day
       ORDER BY FIELD(day, 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`,
      [supplierId, period]
    );

    const hourly = await queryDB(
      `SELECT HOUR(ps.sale_date) AS hour, SUM(ps.total_sale_amount) AS total_sales
       FROM ProductSales ps
       JOIN Product p ON ps.product_id = p.id
       WHERE p.store_id = ? AND ps.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY hour
       ORDER BY hour`,
      [supplierId, period]
    );

    res.json({ daily_sales: daily, hourly_sales: hourly });
  } catch (err) {
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
    const supplierId = await getSupplierProfileId(userId);
    if (!supplierId) return res.status(404).json({ success: false, message: "Supplier profile not found" });

    const kpis = await queryDB(
      `SELECT IFNULL(SUM(p.supplier_purchase_price * ps.quantity_sold),0) AS total_investment,
              IFNULL(SUM(ps.total_sale_amount),0) AS total_sales_value,
              IFNULL(SUM(ps.profit),0) AS total_profit
       FROM Product p
       LEFT JOIN ProductSales ps ON p.id = ps.product_id
       WHERE p.store_id = ? AND ps.sale_date BETWEEN ? AND ?`,
      [supplierId, start, end]
    );

    const products = await queryDB(
      `SELECT id, title, stock_quantity, supplier_purchase_price, supplier_sold_price
       FROM Product WHERE store_id = ?`,
      [supplierId]
    );

    if (type === "json") return res.json({ kpis: kpis[0], products });
    res.status(400).json({ message: "Only JSON export supported now" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;
