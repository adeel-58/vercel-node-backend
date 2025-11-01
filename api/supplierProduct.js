// api/product.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import FTPClient from "basic-ftp";
import { Readable } from "stream";
import queryDB from "../db.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASSWORD;
const FTP_PORT = process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21;
const FTP_BASE_PATH = process.env.FTP_BASE_PATH || "/uploads/products";
const FTP_PUBLIC_URL = process.env.FTP_PUBLIC_URL || "https://storensupply.com/uploads/products";

// ------------------ Helpers ------------------

const handleDBError = (res, err) => {
  console.error("Database error:", err);
  if (err && err.code === "ETIMEDOUT") {
    return res.status(503).json({
      success: false,
      message: "Database timeout. Please try again shortly.",
      error: err.message,
    });
  }
  return res.status(500).json({
    success: false,
    message: "Database error",
    error: err.message || err,
  });
};

const normalizeRemotePath = (p) => {
  if (!p) return p;
  return p.startsWith("/") ? p : `/${p}`;
};

const buildPublicUrl = (remotePath) => {
  if (!remotePath) return null;
  try {
    const p = remotePath.replace(/^\/+/, "");
    const parts = p.split("/").filter(Boolean);
    const uploadsIndex = parts.findIndex((x) => x.toLowerCase() === "uploads");
    if (uploadsIndex >= 0) {
      const afterUploads = parts.slice(uploadsIndex + 1);
      if (afterUploads[0] && afterUploads[0].toLowerCase() === "products") {
        const relative = afterUploads.slice(1).join("/");
        return `${FTP_PUBLIC_URL}/${relative}`;
      } else {
        return `${FTP_PUBLIC_URL}/${afterUploads.join("/")}`;
      }
    }
    return `${FTP_PUBLIC_URL}/${path.basename(remotePath)}`;
  } catch (err) {
    console.warn("buildPublicUrl failed:", err);
    return `${FTP_PUBLIC_URL}/${path.basename(remotePath)}`;
  }
};

// ------------------ FTP Helpers ------------------

const ftpAccessConfig = () => ({
  host: FTP_HOST,
  user: FTP_USER,
  password: FTP_PASS,
  port: FTP_PORT,
  secure: false,
});

const uploadToFTP = async (fileBuffer, filename, remoteFolder) => {
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access(ftpAccessConfig());
    await client.ensureDir(remoteFolder);
    
    // Convert buffer to readable stream for basic-ftp
    const stream = Readable.from(fileBuffer);
    await client.uploadFrom(stream, filename);
    const remote = normalizeRemotePath(path.posix.join(remoteFolder, filename));
    return remote;
  } catch (err) {
    console.error("FTP Upload Error:", err);
    throw new Error("FTP upload failed: " + (err.message || err));
  } finally {
    client.close();
  }
};

const deleteFromFTP = async (remoteFilePath) => {
  if (!remoteFilePath) return false;
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access(ftpAccessConfig());
    const cleaned = remoteFilePath.replace(/^\/+/, "");
    try {
      await client.remove(cleaned);
      return true;
    } catch (err) {
      try {
        const alt = cleaned.replace(/^public_html\/?/i, "");
        await client.remove(alt);
        return true;
      } catch (err2) {
        try {
          await client.remove(path.basename(cleaned));
          return true;
        } catch (err3) {
          console.warn("FTP delete attempts failed:", err.message, err2?.message, err3?.message);
          return false;
        }
      }
    }
  } catch (err) {
    console.warn("FTP Delete Error (non-fatal):", err.message || err);
    return false;
  } finally {
    client.close();
  }
};

// ------------------ Multer Setup (Memory Storage for Vercel) ------------------

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

// Use memory storage instead of disk storage for Vercel serverless
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif|jpg)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (jpeg, png, webp, gif) are allowed"));
    }
  },
});

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
    console.error("Token verify error:", error);
    return res.status(500).json({ success: false, message: "Server error during token verification" });
  }
};

// ------------------ Routes ------------------

/**
 * POST /product/add
 * - Uploads main_image and other_images to FTP, inserts Product + ProductImage rows.
 */
router.post(
  "/add",
  verifyToken,
  upload.fields([{ name: "main_image", maxCount: 1 }, { name: "other_images", maxCount: 5 }]),
  async (req, res) => {
    try {
      const supplierUserId = req.user.userId;

      // 1) Get supplier profile
      const suppliers = await queryDB(
        `SELECT id, plan_id FROM SupplierProfile WHERE user_id = ? LIMIT 1`,
        [supplierUserId]
      );
      if (!suppliers || suppliers.length === 0) {
        return res.status(400).json({ success: false, message: "Supplier profile not found" });
      }
      const storeId = suppliers[0].id;
      const planId = suppliers[0].plan_id;

      // 2) Check plan & limits
      const plans = await queryDB(`SELECT name, upload_limit FROM Plan WHERE id = ? AND is_active = 1 LIMIT 1`, [planId]);
      if (!plans || plans.length === 0) {
        return res.status(403).json({ success: false, message: "Plan inactive or invalid" });
      }
      const plan = plans[0];

      const productCountRows = await queryDB(`SELECT COUNT(*) AS total FROM Product WHERE store_id = ?`, [storeId]);
      const currentCount = (productCountRows && productCountRows[0] && Number(productCountRows[0].total)) || 0;

      if (typeof plan.upload_limit === "number" && plan.upload_limit >= 0 && currentCount >= plan.upload_limit) {
        return res.status(403).json({
          success: false,
          message: `Upload limit reached for plan ${plan.name}`,
        });
      }

      // 3) Prepare product data from body
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

      // 4) FTP upload main image and other images
      const mainImageFile = req.files?.main_image?.[0];
      const otherImageFiles = req.files?.other_images || [];

      let mainImagePath = null;
      const otherImagesPaths = [];

      try {
        if (mainImageFile) {
          const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(mainImageFile.originalname)}`;
          mainImagePath = await uploadToFTP(
            mainImageFile.buffer,
            filename,
            path.posix.join(FTP_BASE_PATH, String(storeId))
          );
        }

        for (const file of otherImageFiles) {
          const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
          const remote = await uploadToFTP(
            file.buffer,
            filename,
            path.posix.join(FTP_BASE_PATH, String(storeId))
          );
          otherImagesPaths.push(remote);
        }
      } catch (ftpErr) {
        console.error("FTP upload failed during product add:", ftpErr);
        return res.status(500).json({ success: false, message: "Image upload failed", error: ftpErr.message || ftpErr });
      }

      // 5) Insert product
      const insertResult = await queryDB(
        `INSERT INTO Product 
          (store_id, ebay_link, title, country, main_image, supplier_purchase_price,
           supplier_sold_price, stock_quantity, status, source_type, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          storeId,
          ebay_link || null,
          title || null,
          country || null,
          mainImagePath ? normalizeRemotePath(mainImagePath) : null,
          supplier_purchase_price || null,
          supplier_sold_price || null,
          stock_quantity ? Number(stock_quantity) : 0,
          status || "active",
          source_type || "manual",
          category || null,
        ]
      );

      const productId = insertResult && insertResult.insertId ? insertResult.insertId : null;

      // 6) Insert other images into ProductImage
      if (productId && otherImagesPaths.length > 0) {
        const placeholders = otherImagesPaths.map(() => "(?, ?, ?)").join(", ");
        const params = [];
        for (const pth of otherImagesPaths) {
          params.push(productId, normalizeRemotePath(pth), 0);
        }
        const sql = `INSERT INTO ProductImage (product_id, image_url, is_primary) VALUES ${placeholders}`;
        await queryDB(sql, params);
      }

      // 7) Update supplier product count (safe)
      try {
        await queryDB(`UPDATE SupplierProfile SET total_products = COALESCE(total_products,0) + 1 WHERE id = ?`, [storeId]);
      } catch (e) {
        console.warn("Failed to increment supplier total_products (non-fatal):", e.message || e);
      }

      return res.json({ success: true, message: "Product added successfully", product_id: productId });
    } catch (err) {
      console.error("❌ Add Product Error:", err);
      return handleDBError(res, err);
    }
  }
);

// GET /product -> get all products for current supplier with optional status filter
router.get("/", verifyToken, async (req, res) => {
  try {
    const statusFilter = req.query.status;

    const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1`, [req.user.userId]);
    if (!supplierRows || supplierRows.length === 0)
      return res.status(400).json({ success: false, message: "Supplier profile not found" });

    const storeId = supplierRows[0].id;

    let sql = `SELECT * FROM Product WHERE store_id = ?`;
    const params = [storeId];
    if (statusFilter && ["active", "paused"].includes(statusFilter)) {
      const mapped = statusFilter === "paused" ? "out_of_stock" : statusFilter;
      sql += ` AND status = ?`;
      params.push(mapped);
    }
    sql += ` ORDER BY created_at DESC`;

    const products = await queryDB(sql, params);

    if (!products || products.length === 0) return res.json({ success: true, products: [] });

    const productIds = products.map((p) => p.id);

    const images = await queryDB(`SELECT * FROM ProductImage WHERE product_id IN (?)`, [productIds]);

    const productsWithImages = products.map((p) => {
      const imgs = (images || [])
        .filter((img) => img.product_id === p.id)
        .map((img) => ({ ...img, image_url: buildPublicUrl(img.image_url) }));
      const mainImageUrl = p.main_image ? buildPublicUrl(p.main_image) : null;
      return { ...p, main_image: mainImageUrl, images: imgs };
    });

    return res.json({ success: true, products: productsWithImages });
  } catch (err) {
    console.error("❌ Fetch Products Error:", err);
    return handleDBError(res, err);
  }
});

// GET /product/:id -> get single product (owner)
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1`, [userId]);
    if (!supplierRows || supplierRows.length === 0)
      return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    const rows = await queryDB(`SELECT * FROM Product WHERE id = ? AND store_id = ? LIMIT 1`, [id, storeId]);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });
    const product = rows[0];

    const images = await queryDB(`SELECT * FROM ProductImage WHERE product_id = ? ORDER BY is_primary DESC, id ASC`, [id]);

    const mainImageUrl = product.main_image ? buildPublicUrl(product.main_image) : null;
    const imgs = (images || []).map((img) => ({ ...img, image_url: buildPublicUrl(img.image_url) }));

    return res.json({ success: true, product: { ...product, main_image: mainImageUrl, images: imgs } });
  } catch (err) {
    console.error("❌ GET single product error:", err);
    return handleDBError(res, err);
  }
});

// PUT /product/:id -> Edit product (replace main image / add gallery images)
router.put(
  "/:id",
  verifyToken,
  upload.fields([{ name: "main_image", maxCount: 1 }, { name: "other_images", maxCount: 5 }]),
  async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
      const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1`, [userId]);
      if (!supplierRows || supplierRows.length === 0) {
        return res.status(404).json({ success: false, message: "Supplier not found" });
      }
      const storeId = supplierRows[0].id;

      const prodRows = await queryDB(`SELECT * FROM Product WHERE id = ? AND store_id = ? LIMIT 1`, [id, storeId]);
      if (!prodRows || prodRows.length === 0) {
        return res.status(404).json({ success: false, message: "Product not found" });
      }
      const product = prodRows[0];

      const fields = ["title", "ebay_link", "supplier_purchase_price", "supplier_sold_price", "stock_quantity", "category", "country", "source_type", "status"];
      const updates = [];
      const params = [];

      fields.forEach((f) => {
        if (req.body[f] !== undefined) {
          updates.push(`${f} = ?`);
          params.push(req.body[f]);
        }
      });

      // main image replacement
      if (req.files && req.files["main_image"] && req.files["main_image"][0]) {
        const newFile = req.files["main_image"][0];
        try {
          const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(newFile.originalname)}`;
          const remotePath = await uploadToFTP(
            newFile.buffer,
            filename,
            path.posix.join(FTP_BASE_PATH, String(storeId))
          );
          if (product.main_image) {
            try { await deleteFromFTP(product.main_image); } catch (e) { console.warn("Failed to delete old main image:", e.message || e); }
          }
          updates.push("main_image = ?");
          params.push(normalizeRemotePath(remotePath));
        } catch (uploadErr) {
          console.error("Main image upload failed:", uploadErr);
          return res.status(500).json({ success: false, message: "Main image upload failed", error: uploadErr.message || uploadErr });
        }
      }

      if (updates.length > 0) {
        params.push(id);
        const sql = `UPDATE Product SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`;
        await queryDB(sql, params);
      }

      // append other images if provided
      if (req.files && req.files["other_images"] && req.files["other_images"].length > 0) {
        const insertValues = [];
        for (const file of req.files["other_images"]) {
          try {
            const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
            const remote = await uploadToFTP(
              file.buffer,
              filename,
              path.posix.join(FTP_BASE_PATH, String(storeId))
            );
            insertValues.push([id, normalizeRemotePath(remote), 0]);
          } catch (uploadErr) {
            console.error("Gallery image upload failed:", uploadErr);
          }
        }
        if (insertValues.length > 0) {
          const placeholders = insertValues.map(() => "(?, ?, ?)").join(", ");
          const flattened = insertValues.flat();
          const sql = `INSERT INTO ProductImage (product_id, image_url, is_primary) VALUES ${placeholders}`;
          await queryDB(sql, flattened);
        }
      }

      return res.json({ success: true, message: "Product updated successfully" });
    } catch (err) {
      console.error("❌ Edit product error:", err);
      return handleDBError(res, err);
    }
  }
);

// DELETE single gallery image
router.delete("/:id/image/:imageId", verifyToken, async (req, res) => {
  try {
    const { id, imageId } = req.params;
    const userId = req.user.userId;

    const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1`, [userId]);
    if (!supplierRows || supplierRows.length === 0)
      return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    const prodRows = await queryDB(`SELECT * FROM Product WHERE id = ? AND store_id = ? LIMIT 1`, [id, storeId]);
    if (!prodRows || prodRows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });

    const imgRows = await queryDB(`SELECT * FROM ProductImage WHERE id = ? AND product_id = ? LIMIT 1`, [imageId, id]);
    if (!imgRows || imgRows.length === 0) return res.status(404).json({ success: false, message: "Image not found" });

    const img = imgRows[0];
    try {
      await deleteFromFTP(img.image_url);
    } catch (err) {
      console.warn("FTP delete failed for image (non-fatal):", img.image_url, err.message || err);
    }

    await queryDB(`DELETE FROM ProductImage WHERE id = ?`, [imageId]);

    return res.json({ success: true, message: "Image deleted successfully" });
  } catch (err) {
    console.error("❌ Delete image error:", err);
    return handleDBError(res, err);
  }
});

// DELETE product + images
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1`, [userId]);
    if (!supplierRows || supplierRows.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    const prodRows = await queryDB(`SELECT * FROM Product WHERE id = ? AND store_id = ? LIMIT 1`, [id, storeId]);
    if (!prodRows || prodRows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });
    const product = prodRows[0];

    const images = await queryDB(`SELECT * FROM ProductImage WHERE product_id = ?`, [id]);

    if (product.main_image) {
      try { await deleteFromFTP(product.main_image); } catch (e) { console.warn("Failed to delete main image:", e.message || e); }
    }

    for (const img of (images || [])) {
      try { await deleteFromFTP(img.image_url); } catch (e) { console.warn("Failed to delete gallery image:", img.image_url, e.message || e); }
    }

    await queryDB(`DELETE FROM ProductImage WHERE product_id = ?`, [id]);
    await queryDB(`DELETE FROM Product WHERE id = ?`, [id]);

    try {
      await queryDB(`UPDATE SupplierProfile SET total_products = GREATEST(0, COALESCE(total_products,0) - 1) WHERE id = ?`, [storeId]);
    } catch (e) {
      console.warn("Failed to decrement product count (non-fatal):", e.message || e);
    }

    return res.json({ success: true, message: "Product and images deleted successfully" });
  } catch (err) {
    console.error("❌ Delete product error:", err);
    return handleDBError(res, err);
  }
});

// PATCH product status
router.patch("/:id/status", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    let { status } = req.body;
    const userId = req.user.userId;

    if (status === "paused") status = "out_of_stock";
    if (!["active", "out_of_stock", "archived"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const supplierRows = await queryDB(`SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1`, [userId]);
    if (!supplierRows || supplierRows.length === 0) return res.status(404).json({ success: false, message: "Supplier not found" });
    const storeId = supplierRows[0].id;

    const rows = await queryDB(`SELECT * FROM Product WHERE id = ? AND store_id = ? LIMIT 1`, [id, storeId]);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: "Product not found" });

    await queryDB(`UPDATE Product SET status = ?, updated_at = NOW() WHERE id = ?`, [status, id]);
    return res.json({ success: true, message: `Product status updated to ${status}` });
  } catch (err) {
    console.error("Toggle status error:", err);
    return handleDBError(res, err);
  }
});

export default router;