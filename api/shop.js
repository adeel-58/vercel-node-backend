// routes/shop.js
import express from "express";
import queryDB from "../db.js";

const router = express.Router();

/**
 * GET /api/shop
 * Query Params:
 *  - limit (default 12)
 *  - offset (default 0)
 *  - category (optional)
 *  - country (optional)
 *  - sort ('asc' | 'desc' optional)
 */
router.get("/", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 12;
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category?.trim() || "";
    const country = req.query.country?.trim() || "";
    const sort = req.query.sort || "";

    // ORDER BY
    let orderBy = "";
    if (sort === "asc") orderBy = "ORDER BY p.supplier_sold_price ASC";
    else if (sort === "desc") orderBy = "ORDER BY p.supplier_sold_price DESC";
    else orderBy = "ORDER BY p.id DESC";

    // Dynamic WHERE clause
    const conditions = ["p.status='active'", "p.stock_quantity>0"];
    const params = [];

    if (category) {
      conditions.push("LOWER(TRIM(p.category)) = LOWER(?)");
      params.push(category);
    }

    if (country) {
      conditions.push("LOWER(TRIM(p.country)) = LOWER(?)");
      params.push(country);
    }

    const sql = `
      SELECT 
        p.id AS product_id,
        p.title AS product_name,
        p.supplier_purchase_price,
        p.supplier_sold_price,
        p.main_image,
        p.stock_quantity,
        p.category,
        p.country AS product_country,
        sp.id AS supplier_id,
        sp.store_name AS supplier_name,
        sp.logo AS supplier_logo
      FROM Product p
      JOIN SupplierProfile sp ON p.store_id = sp.id
      WHERE ${conditions.join(" AND ")}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    // Debug: log SQL + params
    console.log("SQL:", sql);
    console.log("Params:", params);

    const products = await queryDB(sql, params);

    const baseURL = process.env.VITE_IMAGE_BASE_URL2 || "https://storensupply.com";

    const formattedProducts = products.map((p) => ({
      product_id: p.product_id,
      product_name: p.product_name,
      supplier_price: p.supplier_purchase_price,
      selling_price: p.supplier_sold_price,
      stock_quantity: p.stock_quantity,
      category: p.category,
      country: p.product_country,
      supplier_id: p.supplier_id,
      supplier_name: p.supplier_name,
      product_image: p.main_image ? `${baseURL}${p.main_image}` : null,
      supplier_logo: p.supplier_logo ? `${baseURL}${p.supplier_logo}` : null,
    }));

    res.json({ success: true, products: formattedProducts });
  } catch (error) {
    console.error("❌ Error fetching shop products:", error);
    res.status(500).json({ success: false, message: "Failed to load products" });
  }
});

export default router;
