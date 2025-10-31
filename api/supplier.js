// api/supplier.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import FTPClient from "basic-ftp";
import queryDB from "../db.js"; // <-- ETIMEDOUT-safe query helper

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASSWORD;
const FTP_PORT = process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 21;
const FTP_BASE_PATH = process.env.FTP_BASE_PATH || "/uploads/products"; // root folder for product images
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

const removeLocalFileSafe = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("Failed to remove temp file:", filePath, e.message);
  }
};

// Normalize remote path for storage (ensure leading slash)
const normalizeRemotePath = (p) => {
  if (!p) return p;
  return p.startsWith("/") ? p : `/${p}`;
};

// Build a public HTTP URL from stored remote path
const buildPublicUrl = (remotePath) => {
  if (!remotePath) return null;
  try {
    const p = remotePath.replace(/^\/+/, ""); // remove leading slashes
    // remotePath may be: "uploads/products/12/file.jpg" or "public_html/uploads/products/12/file.jpg"
    // We want the relative part under uploads/products
    const parts = p.split("/").filter(Boolean);
    const uploadsIndex = parts.findIndex((x) => x.toLowerCase() === "uploads");
    if (uploadsIndex >= 0) {
      const afterUploads = parts.slice(uploadsIndex + 1); // e.g. ["products","12","file.jpg"]
      // If the first is "products", remove to avoid double products in URL
      if (afterUploads[0] && afterUploads[0].toLowerCase() === "products") {
        const relative = afterUploads.slice(1).join("/");
        return `${FTP_PUBLIC_URL}/${relative}`;
      } else {
        return `${FTP_PUBLIC_URL}/${afterUploads.join("/")}`;
      }
    }
    // fallback: use basename
    return `${FTP_PUBLIC_URL}/${path.basename(p)}`;
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

const uploadToFTP = async (localFilePath, remoteFolder) => {
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access(ftpAccessConfig());
    // ensureDir will cd into directory, creating it if needed
    await client.ensureDir(remoteFolder);
    // change to the dir to avoid path issues and upload basename
    await client.uploadFrom(localFilePath, path.basename(localFilePath));
    // return normalized path
    const remote = normalizeRemotePath(path.posix.join(remoteFolder, path.basename(localFilePath)));
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
    // try the exact path first
    const cleaned = remoteFilePath.replace(/^\/+/, ""); // remove leading slashes
    try {
      await client.remove(cleaned);
      return true;
    } catch (err) {
      // try alternative variants
      try {
        // if path contains public_html, remove it
        const alt = cleaned.replace(/^public_html\/?/i, "");
        await client.remove(alt);
        return true;
      } catch (err2) {
        // As a last resort, attempt remove of basename only
        await client.remove(path.basename(cleaned));
        return true;
      }
    }
  } catch (err) {
    console.warn("FTP Delete Error (non-fatal):", err.message || err);
    // don't throw — deletion failure should not crash the whole flow
    return false;
  } finally {
    client.close();
  }
};

// ------------------ Multer Setup (temp storage) ------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempPath = path.join(process.cwd(), "temp_uploads");
    if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
    cb(null, tempPath);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${unique}${path.extname(file.originalname)}`);
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
      if (err) return res.status(401).json({ success: false, message: "Invalid or expired token" });
      req.user = decoded;
      next();
    });
  } catch (err) {
    console.error("Token verify error:", err);
    return res.status(500).json({ success: false, message: "Token verification error" });
  }
};

// ------------------ ROUTES ------------------

/**
 * POST /supplier/create
 * Fields: user_id, store_name, store_description, whatsapp_number, country
 * Optional file: logo
 *
 * Behavior:
 * - Prevents multiple supplier profiles per user (returns 409)
 * - Creates SupplierProfile, assigns free plan
 * - If logo provided, uploads to FTP under FTP_BASE_PATH/{supplierId}
 */
router.post("/create", upload.single("logo"), async (req, res) => {
  const { user_id, store_name, store_description, whatsapp_number, country } = req.body;
  const logoFile = req.file;

  if (!user_id || !store_name) {
    removeLocalFileSafe(logoFile?.path);
    return res.status(400).json({ success: false, message: "user_id and store_name are required" });
  }

  try {
    // Prevent duplicate supplier profile
    const existing = await queryDB("SELECT id FROM SupplierProfile WHERE user_id = ? LIMIT 1", [user_id]);
    if (existing && existing.length > 0) {
      removeLocalFileSafe(logoFile?.path);
      return res.status(409).json({ success: false, message: "Supplier profile already exists for this user" });
    }

    // 1. Fetch default free plan (if not found -> fallback to null plan)
    const plans = await queryDB("SELECT * FROM Plan WHERE plan_type = 'free' AND is_active = 1 LIMIT 1");
    const freePlan = plans && plans[0] ? plans[0] : null;

    // 2. Calculate plan start/end
    const planStart = new Date();
    let planEnd = null;
    if (freePlan && freePlan.duration_days) {
      planEnd = new Date();
      planEnd.setDate(planEnd.getDate() + Number(freePlan.duration_days));
    }

    // 3. Insert SupplierProfile with logo NULL for now
    const insertResult = await queryDB(
      `INSERT INTO SupplierProfile 
        (user_id, store_name, store_description, whatsapp_number, country, logo, plan_id, plan_start, plan_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        user_id,
        store_name,
        store_description || null,
        whatsapp_number || null,
        country || null,
        null,
        freePlan ? freePlan.id : null,
        planStart,
        planEnd,
      ]
    );

    // insertResult may be result object with insertId
    const supplierId = insertResult && insertResult.insertId ? insertResult.insertId : null;

    let finalLogoRemotePath = null;
    if (logoFile && supplierId) {
      try {
        const remoteFolder = path.posix.join(FTP_BASE_PATH, String(supplierId)); // e.g. /uploads/products/12
        const remote = await uploadToFTP(logoFile.path, remoteFolder);
        finalLogoRemotePath = normalizeRemotePath(remote);
      } catch (uploadErr) {
        console.warn("Logo FTP upload failed (non-fatal):", uploadErr.message || uploadErr);
        // continue - supplier profile is created; we'll inform client below
      } finally {
        removeLocalFileSafe(logoFile.path);
      }

      if (finalLogoRemotePath) {
        try {
          await queryDB("UPDATE SupplierProfile SET logo = ? WHERE id = ?", [finalLogoRemotePath, supplierId]);
        } catch (e) {
          console.warn("Failed to update SupplierProfile.logo after upload:", e.message || e);
        }
      }
    } else {
      // make sure temp file removed if present but no supplierId
      removeLocalFileSafe(logoFile?.path);
    }

    // 5. Update user role to 'both' (safe update)
    try {
      await queryDB("UPDATE `User` SET role = 'both' WHERE id = ?", [user_id]);
    } catch (e) {
      console.warn("Failed to update User role to 'both':", e.message || e);
      // not fatal
    }

    // 6. Fetch and return the created supplier profile (with plan info)
    const profileRows = await queryDB(
      `SELECT sp.*, p.name AS plan_name, p.plan_type, p.upload_limit, p.price, p.duration_days
       FROM SupplierProfile sp
       LEFT JOIN Plan p ON sp.plan_id = p.id
       WHERE sp.id = ?`,
      [supplierId]
    );

    const profile = profileRows && profileRows[0] ? profileRows[0] : null;
    if (profile) profile.logo = profile.logo ? buildPublicUrl(profile.logo) : null;

    return res.status(201).json({
      success: true,
      message: "Supplier profile created",
      supplierProfile: profile,
      note: finalLogoRemotePath ? undefined : logoFile ? "Logo upload failed or skipped." : undefined,
    });
  } catch (err) {
    removeLocalFileSafe(req.file?.path);
    return handleDBError(res, err);
  }
});

/**
 * PUT /supplier/update
 * Auth required. Update supplier fields; logo optional (if provided, upload and delete old)
 */
router.put("/update", verifyToken, upload.single("logo"), async (req, res) => {
  try {
    const userId = req.user.userId;
    const { store_name, store_description, whatsapp_number, country } = req.body;
    const logoFile = req.file;

    // Find supplier by user_id
    const supplierRows = await queryDB("SELECT * FROM SupplierProfile WHERE user_id = ? LIMIT 1", [userId]);
    if (!supplierRows || supplierRows.length === 0) {
      removeLocalFileSafe(logoFile?.path);
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const supplier = supplierRows[0];
    const supplierId = supplier.id;

    // Build update query for fields
    const updates = [];
    const params = [];

    if (store_name !== undefined) { updates.push("store_name = ?"); params.push(store_name); }
    if (store_description !== undefined) { updates.push("store_description = ?"); params.push(store_description); }
    if (whatsapp_number !== undefined) { updates.push("whatsapp_number = ?"); params.push(whatsapp_number); }
    if (country !== undefined) { updates.push("country = ?"); params.push(country); }

    // Handle logo replacement
    if (logoFile) {
      let newRemotePath = null;
      try {
        const remoteFolder = path.posix.join(FTP_BASE_PATH, String(supplierId));
        const remote = await uploadToFTP(logoFile.path, remoteFolder);
        newRemotePath = normalizeRemotePath(remote);
      } catch (uploadErr) {
        removeLocalFileSafe(logoFile.path);
        console.error("Logo upload failed during update:", uploadErr.message || uploadErr);
        return res.status(500).json({ success: false, message: "Logo upload failed", error: (uploadErr.message || uploadErr) });
      } finally {
        removeLocalFileSafe(logoFile.path);
      }

      // Attempt delete of old logo (non-fatal)
      if (supplier.logo) {
        try {
          await deleteFromFTP(supplier.logo);
        } catch (delErr) {
          console.warn("Failed to delete old supplier logo from FTP (non-fatal):", delErr.message || delErr);
        }
      }

      updates.push("logo = ?");
      params.push(newRemotePath);
    }

    if (updates.length > 0) {
      params.push(supplierId);
      const sql = `UPDATE SupplierProfile SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`;
      await queryDB(sql, params);
    }

    // Return updated supplier
    const updatedRows = await queryDB("SELECT * FROM SupplierProfile WHERE id = ? LIMIT 1", [supplierId]);
    const updatedSupplier = updatedRows && updatedRows[0] ? updatedRows[0] : null;
    if (updatedSupplier) updatedSupplier.logo = updatedSupplier.logo ? buildPublicUrl(updatedSupplier.logo) : null;

    return res.json({ success: true, message: "Supplier updated", supplier: updatedSupplier });
  } catch (err) {
    removeLocalFileSafe(req.file?.path);
    return handleDBError(res, err);
  }
});

export default router;
