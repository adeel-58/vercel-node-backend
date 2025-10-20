// api/product.js
import express from "express";
import pool from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import FTPClient from "basic-ftp";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASSWORD;
const FTP_PORT = process.env.FTP_PORT || 21;
const FTP_BASE_PATH = process.env.FTP_BASE_PATH || "/public_html/uploads/products";

// ------------------ Multer Setup (Temp Storage) ------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempPath = "temp_uploads";
    if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
    cb(null, tempPath);
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

// ------------------ FTP Upload Helper ------------------
const uploadToFTP = async (localFilePath, remoteFolder) => {
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: FTP_PORT,
    });

    // Ensure remote folder exists
    await client.ensureDir(remoteFolder);
    await client.uploadFrom(localFilePath, path.basename(localFilePath));

    return `${remoteFolder}/${path.basename(localFilePath)}`;
  } catch (err) {
    console.error("FTP Upload Error:", err);
    throw new Error("FTP upload failed");
  } finally {
    client.close();
  }
};

// ------------------ Routes ------------------

// POST /product/add
router.post(
  "/add",
  verifyToken,
  upload.fields([{ name: "main_image", maxCount: 1 }, { name: "other_images", maxCount: 5 }]),
  async (req, res) => {
    const connection = pool;

    try {
      const supplierUserId = req.user.userId;

      // 1️⃣ Get supplier profile
      const [supplierRows] = await connection.query(
        `SELECT id, plan_id FROM SupplierProfile WHERE user_id = ?`,
        [supplierUserId]
      );
      if (supplierRows.length === 0)
        return res.status(400).json({ success: false, message: "Supplier profile not found" });

      const storeId = supplierRows[0].id;

      // 2️⃣ Check plan & limits
      const [planRows] = await connection.query(
        `SELECT name, upload_limit FROM Plan WHERE id = ? AND is_active = 1`,
        [supplierRows[0].plan_id]
      );
      if (planRows.length === 0)
        return res.status(403).json({ success: false, message: "Plan inactive or invalid" });

      const [productCountRows] = await connection.query(
        `SELECT COUNT(*) AS total FROM Product WHERE store_id = ?`,
        [storeId]
      );
      if (productCountRows[0].total >= planRows[0].upload_limit)
        return res.status(403).json({
          success: false,
          message: `Upload limit reached for plan ${planRows[0].name}`,
        });

      // 3️⃣ Prepare product data
      const {
        title,
        ebay_link,
        supplier_purchase_price,
        supplier_sold_price,
        stock_quantity,
        category,
        country,
        source_type,
        status,
      } = req.body;

      // 4️⃣ Upload images via FTP
      const mainImageFile = req.files["main_image"]?.[0];
      const otherImageFiles = req.files["other_images"] || [];

      let mainImagePath = null;
      const otherImagesPaths = [];

      if (mainImageFile) {
        mainImagePath = await uploadToFTP(mainImageFile.path, `${FTP_BASE_PATH}/${storeId}`);
        fs.unlinkSync(mainImageFile.path);
      }

      for (const file of otherImageFiles) {
        const remotePath = await uploadToFTP(file.path, `${FTP_BASE_PATH}/${storeId}`);
        otherImagesPaths.push(remotePath);
        fs.unlinkSync(file.path);
      }

      // 5️⃣ Insert Product
      const [result] = await connection.query(
        `INSERT INTO Product 
        (store_id, ebay_link, title, country, main_image, supplier_purchase_price,
          supplier_sold_price, stock_quantity, status, source_type, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          storeId,
          ebay_link || null,
          title,
          country || null,
          mainImagePath,
          supplier_purchase_price,
          supplier_sold_price || null,
          stock_quantity || 0,
          status || "active",
          source_type || "manual",
          category || null,
        ]
      );

      const productId = result.insertId;

      // 6️⃣ Insert other images
      if (otherImagesPaths.length > 0) {
        const values = otherImagesPaths.map((p) => [productId, p, false]);
        await connection.query(`INSERT INTO ProductImage (product_id, image_url, is_primary) VALUES ?`, [values]);
      }

      // 7️⃣ Update supplier product count
      await connection.query(`UPDATE SupplierProfile SET total_products = total_products + 1 WHERE id = ?`, [storeId]);

      res.json({ success: true, message: "Product added successfully", product_id: productId });
    } catch (err) {
      console.error("❌ Add Product Error:", err);
      return res.status(500).json({ success: false, message: "Failed to add product", error: err.message });
    }
  }
);// GET /product  -> get all products for current supplier
// GET /product  -> get all products for current supplier with optional status filter
router.get("/", verifyToken, async (req, res) => {
  try {
    const statusFilter = req.query.status; // optional "active" or "paused"

    const [supplier] = await pool.query(
      `SELECT id FROM SupplierProfile WHERE user_id = ?`,
      [req.user.userId]
    );
    if (supplier.length === 0)
      return res.status(400).json({ success: false, message: "Supplier profile not found" });

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
    const [images] = await pool.query(
      `SELECT * FROM ProductImage WHERE product_id IN (?)`,
      [productIds]
    );

    // Use your public domain for images
    const FTP_PUBLIC_URL = "https://storensupply.com/uploads/products";

    const productsWithImages = products.map((p) => {
      const imgs = images
        .filter((img) => img.product_id === p.id)
        .map((img) => ({
          ...img,
          image_url: `${FTP_PUBLIC_URL}/${img.image_url.split("/").slice(-2).join("/")}` // folder + filename
        }));

      const mainImageUrl = p.main_image
        ? `${FTP_PUBLIC_URL}/${p.main_image.split("/").slice(-2).join("/")}`
        : null;

      return {
        ...p,
        main_image: mainImageUrl,
        images: imgs,
      };
    });

    res.json({ success: true, products: productsWithImages });
  } catch (err) {
    console.error("❌ Fetch Products Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: err.message,
    });
  }
});
// ------------------ FTP Delete Helper ------------------
const deleteFromFTP = async (remoteFilePath) => {
  // remoteFilePath should be a full remote path like: `${FTP_BASE_PATH}/${storeId}/${filename}`
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: FTP_PORT,
    });

    // If the stored path includes the FTP_BASE_PATH, use it as-is.
    // basic-ftp expects a remote path relative to the FTP root.
    // Example remoteFilePath: /public_html/uploads/products/17/12345.jpg
    // But on some hosts the FTP root is already /public_html. If deletion fails, try removing leading /public_html.
    try {
      await client.remove(remoteFilePath);
      return true;
    } catch (err) {
      // Try without /public_html prefix if present
      const alt = remoteFilePath.replace(/^\/?public_html\/?/i, "/");
      await client.remove(alt);
      return true;
    }
  } catch (err) {
    console.error("FTP Delete Error:", err);
    throw new Error("FTP delete failed");
  } finally {
    client.close();
  }
};

// Helper to build public URL from stored remote path
const buildPublicUrl = (remotePath) => {
  // remotePath is like: /public_html/uploads/products/<storeId>/<file>
  // We want: https://storensupply.com/uploads/products/<storeId>/<file>
  const FTP_PUBLIC_URL = process.env.FTP_PUBLIC_URL || "https://storensupply.com/uploads/products";
  // extract <storeId>/<file> part
  const parts = remotePath.split("/").filter(Boolean); // remove empty
  // find index of "uploads" in parts
  const uploadsIndex = parts.findIndex((p) => p.toLowerCase() === "uploads");
  if (uploadsIndex >= 0) {
    const rel = parts.slice(uploadsIndex + 2).length ? parts.slice(uploadsIndex + 1).join("/") : parts.slice(uploadsIndex + 1).join("/");
    // If parts are ["public_html","uploads","products","17","file.jpg"] => rel = "products/17/file.jpg"
    // We expect FTP_PUBLIC_URL already points to /uploads/products so join last two segments if needed
    const afterUploads = parts.slice(uploadsIndex + 1); // ["products","17","file.jpg"]
    return `${FTP_PUBLIC_URL}/${afterUploads.slice(1).join("/")}`; // remove "products" because FTP_PUBLIC_URL already includes it
  }
  // fallback — return FTP_PUBLIC_URL + basename
  return `${FTP_PUBLIC_URL}/${path.basename(remotePath)}`;
};

// ------------------ GET single product (owner) ------------------
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Validate supplier ownership
    const [supplierRows] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplierRows.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    // Fetch product
    const [rows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });
    const product = rows[0];

    // Fetch product images
    const [images] = await pool.query(`SELECT * FROM ProductImage WHERE product_id = ? ORDER BY is_primary DESC, id ASC`, [id]);

    // Build public URLs
    const mainImageUrl = product.main_image ? buildPublicUrl(product.main_image) : null;
    const imgs = images.map((img) => ({ ...img, image_url: buildPublicUrl(img.image_url) }));

    res.json({ success: true, product: { ...product, main_image: mainImageUrl, images: imgs } });
  } catch (err) {
    console.error("❌ GET single product error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch product", error: err.message });
  }
});

// ------------------ PUT /product/:id -> Edit product ------------------
// Supports optional main_image replacement and adding other_images.
// If main image is replaced, old remote file will be deleted.
router.put(
  "/:id",
  verifyToken,
  upload.fields([{ name: "main_image", maxCount: 1 }, { name: "other_images", maxCount: 5 }]),
  async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
      // Check supplier ownership
      const [supplierRows] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
      if (supplierRows.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
      const storeId = supplierRows[0].id;

      // Check product belongs to supplier
      const [prodRows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
      if (prodRows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });
      const product = prodRows[0];

      // Fields to update
      const fields = ["title", "ebay_link", "supplier_purchase_price", "supplier_sold_price", "stock_quantity", "category", "country", "source_type", "status"];
      const updates = [];
      const params = [];

      fields.forEach((f) => {
        if (req.body[f] !== undefined) {
          updates.push(`${f} = ?`);
          params.push(req.body[f]);
        }
      });

      // Handle main image replacement (optional)
      if (req.files && req.files["main_image"] && req.files["main_image"][0]) {
        const newFile = req.files["main_image"][0];
        // Upload new image to FTP
        const remotePath = await uploadToFTP(newFile.path, `${FTP_BASE_PATH}/${storeId}`);
        // Delete temp file
        try { fs.unlinkSync(newFile.path); } catch (e) {}
        // Delete old main image from FTP (if exists)
        if (product.main_image) {
          try { await deleteFromFTP(product.main_image); } catch (e) { console.warn("Failed to delete old main image:", e.message); }
        }
        updates.push("main_image = ?");
        params.push(remotePath);
      }

      // Apply update query if any fields changed
      if (updates.length > 0) {
        params.push(id);
        await pool.query(`UPDATE Product SET ${updates.join(", ")} WHERE id = ?`, params);
      }

      // Handle new gallery images appended
      if (req.files && req.files["other_images"] && req.files["other_images"].length > 0) {
        const newImages = req.files["other_images"];
        const insertValues = [];
        for (const file of newImages) {
          const remote = await uploadToFTP(file.path, `${FTP_BASE_PATH}/${storeId}`);
          try { fs.unlinkSync(file.path); } catch (e) {}
          insertValues.push([id, remote, false]);
        }
        if (insertValues.length > 0) {
          await pool.query(`INSERT INTO ProductImage (product_id, image_url, is_primary) VALUES ?`, [insertValues]);
        }
      }

      res.json({ success: true, message: "Product updated successfully" });
    } catch (err) {
      console.error("❌ Edit product error:", err);
      res.status(500).json({ success: false, message: "Failed to update product", error: err.message });
    }
  }
);

// ------------------ DELETE /product/:id/image/:imageId -> Delete single gallery image ------------------
router.delete("/:id/image/:imageId", verifyToken, async (req, res) => {
  try {
    const { id, imageId } = req.params;
    const userId = req.user.userId;

    // Check owner
    const [supplierRows] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplierRows.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    // Verify image belongs to product and product belongs to supplier
    const [prodRows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
    if (prodRows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });

    const [imgRows] = await pool.query(`SELECT * FROM ProductImage WHERE id = ? AND product_id = ?`, [imageId, id]);
    if (imgRows.length === 0) return res.status(404).json({ success: false, message: "Image not found" });

    const img = imgRows[0];

    // Delete remote file
    try {
      await deleteFromFTP(img.image_url);
    } catch (err) {
      console.warn("FTP delete failed for image:", img.image_url, err.message);
      // continue to remove DB row even if file deletion failed
    }

    // Remove DB row
    await pool.query(`DELETE FROM ProductImage WHERE id = ?`, [imageId]);

    res.json({ success: true, message: "Image deleted successfully" });
  } catch (err) {
    console.error("❌ Delete image error:", err);
    res.status(500).json({ success: false, message: "Failed to delete image", error: err.message });
  }
});

// ------------------ DELETE /product/:id -> Delete product + images ------------------
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Check owner
    const [supplierRows] = await pool.query(`SELECT id FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplierRows.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    // Verify product
    const [prodRows] = await pool.query(`SELECT * FROM Product WHERE id = ? AND store_id = ?`, [id, storeId]);
    if (prodRows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });
    const product = prodRows[0];

    // Fetch product images (gallery)
    const [images] = await pool.query(`SELECT * FROM ProductImage WHERE product_id = ?`, [id]);

    // Delete main image from FTP if present
    if (product.main_image) {
      try {
        await deleteFromFTP(product.main_image);
      } catch (err) {
        console.warn("Failed to delete main image:", err.message);
      }
    }

    // Delete gallery images from FTP
    for (const img of images) {
      try {
        await deleteFromFTP(img.image_url);
      } catch (err) {
        console.warn("Failed to delete gallery image:", img.image_url, err.message);
      }
    }

    // Delete DB rows
    await pool.query(`DELETE FROM ProductImage WHERE product_id = ?`, [id]);
    await pool.query(`DELETE FROM Product WHERE id = ?`, [id]);

    // Decrement supplier product count (optional safe)
    await pool.query(`UPDATE SupplierProfile SET total_products = GREATEST(0, total_products - 1) WHERE id = ?`, [storeId]);

    res.json({ success: true, message: "Product and images deleted successfully" });
  } catch (err) {
    console.error("❌ Delete product error:", err);
    res.status(500).json({ success: false, message: "Failed to delete product", error: err.message });
  }
});
// ✅ PATCH product status

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
