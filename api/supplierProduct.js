import express from "express";
import pool from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

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
const upload = multer({ storage });

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
      req.user = decoded;
      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error during token verification" });
  }
};

// ------------------ Routes ------------------

// GET /product  -> get all products for current supplier with optional status filter
router.get("/", verifyToken, async (req, res) => {
  try {
    const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
    const statusFilter = req.query.status; // optional "active" or "paused"

    const [supplier] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [req.user.userId]);
    if (supplier.length === 0) return res.status(400).json({ success: false, message: "Supplier profile not found" });

    const storeId = supplier[0].id;

    let sql = `SELECT * FROM Product WHERE store_id = ?`;
    const params = [storeId];
    if (statusFilter && ["active", "paused"].includes(statusFilter)) {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }
    sql += ` ORDER BY created_at DESC`;

    const [products] = await pool.query(sql, params);

    if (products.length === 0) return res.json({ success: true, products: [] });

    const productIds = products.map((p) => p.id);
    const [images] = await pool.query(`SELECT * FROM ProductImage WHERE product_id IN (?)`, [productIds]);

    const productsWithImages = products.map((p) => {
      const imgs = images
        .filter((img) => img.product_id === p.id)
        .map((img) => ({ ...img, image_url: `${SERVER_URL}/${img.image_url.replace(/\\/g, "/")}` }));
      return {
        ...p,
        main_image: p.main_image ? `${SERVER_URL}/${p.main_image.replace(/\\/g, "/")}` : null,
        images: imgs,
      };
    });

    res.json({ success: true, products: productsWithImages });
  } catch (err) {
    console.error("❌ Fetch Products Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch products", error: err.message });
  }
});

// POST /product/add -> add new product
router.post(
  "/add",
  verifyToken,
  upload.fields([{ name: "main_image", maxCount: 1 }, { name: "other_images", maxCount: 5 }]),
  async (req, res) => {
    try {
      const supplierUserId = req.user.userId;
      const [supplier] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [supplierUserId]);
      if (supplier.length === 0) return res.status(400).json({ success: false, message: "Supplier profile not found" });

      const storeId = supplier[0].id;
      const { title, ebay_link, supplier_purchase_price, supplier_sold_price, stock_quantity, category, country, source_type, status } = req.body;
      const mainImageFile = req.files["main_image"]?.[0];
      const otherImageFiles = req.files["other_images"] || [];

      const [result] = await pool.query(
        `INSERT INTO Product 
         (store_id, ebay_link, title, country, main_image, supplier_purchase_price,
          supplier_sold_price, stock_quantity, status, source_type, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          storeId,
          ebay_link || null,
          title,
          country || null,
          mainImageFile ? mainImageFile.path : null,
          supplier_purchase_price,
          supplier_sold_price || null,
          stock_quantity || 0,
          status || "active",
          source_type || "manual",
          category || null,
        ]
      );

      const productId = result.insertId;
      if (otherImageFiles.length > 0) {
        const values = otherImageFiles.map((f) => [productId, f.path, false]);
        await pool.query(`INSERT INTO ProductImage (product_id, image_url, is_primary) VALUES ?`, [values]);
      }

      await pool.query(`UPDATE SupplierProfile SET total_products = total_products + 1 WHERE id = ?`, [storeId]);

      res.json({ success: true, message: "Product added successfully", product_id: productId });
    } catch (err) {
      console.error("❌ Add Product Error:", err);
      res.status(500).json({ success: false, message: "Failed to add product" });
    }
  }
);

// DELETE /product/:id -> delete a product
router.delete("/:id", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  try {
    const [supplier] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplier.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplier[0].id;

    const [rows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });

    const [images] = await pool.query(`SELECT image_url FROM ProductImage WHERE product_id = ?`, [id]);
    images.forEach((img) => {
      const imgPath = img.image_url.replace(/^https?:\/\/[^/]+/, "");
      const fullPath = path.join(process.cwd(), imgPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    });

    await pool.query(`DELETE FROM ProductImage WHERE product_id = ?`, [id]);
    await pool.query(`DELETE FROM Product WHERE id = ?`, [id]);

    res.json({ success: true, message: "Product deleted successfully" });
  } catch (err) {
    console.error("Error deleting product:", err);
    res.status(500).json({ success: false, message: "Failed to delete product" });
  }
});

// PUT /product/:id -> edit/update product
router.put("/:id", verifyToken, upload.fields([{ name: "main_image", maxCount: 1 }, { name: "other_images", maxCount: 5 }]), async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    const [supplier] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplier.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplier[0].id;

    const [rows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });

    const product = rows[0];
    const fields = ["title", "ebay_link", "supplier_purchase_price", "supplier_sold_price", "stock_quantity", "category", "country", "source_type", "status"];
    const updates = [];
    const params = [];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f]);
      }
    });

    if (req.files["main_image"]) {
      if (product.main_image) {
        const oldPath = path.join(process.cwd(), product.main_image);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      updates.push("main_image = ?");
      params.push(req.files["main_image"][0].path);
    }

    params.push(id);
    if (updates.length > 0) {
      await pool.query(`UPDATE Product SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    if (req.files["other_images"]) {
      for (const file of req.files["other_images"]) {
        await pool.query(`INSERT INTO ProductImage (product_id, image_url, is_primary) VALUES (?, ?, false)`, [id, file.path]);
      }
    }

    res.json({ success: true, message: "Product updated successfully" });
  } catch (err) {
    console.error("Edit product error:", err);
    res.status(500).json({ success: false, message: "Failed to update product" });
  }
});

// PATCH /product/:id/status
router.patch("/:id/status", verifyToken, async (req, res) => {
  const { id } = req.params;
  let { status } = req.body; // frontend may send "paused" or "active"
  const userId = req.user.userId;

  // Map frontend "paused" to DB "out_of_stock"
  if (status === "paused") status = "out_of_stock";

  // Only allow valid DB statuses
  if (!["active", "out_of_stock", "archived"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid status" });
  }

  try {
    const [supplier] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplier.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplier[0].id;

    const [rows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });

    await pool.query(`UPDATE Product SET status = ? WHERE id = ?`, [status, id]);
    res.json({ success: true, message: `Product status updated to ${status}` });
  } catch (err) {
    console.error("Toggle status error:", err);
    res.status(500).json({ success: false, message: "Failed to update product status" });
  }
});


export default router;
