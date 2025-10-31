import express from "express";
import queryDB from "../db.js"; // use stable queryDB

const router = express.Router();

// ✅ Get Random Public Products
router.get("/random", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;

    const products = await queryDB(
      `
      SELECT 
        p.id AS product_id,
        p.title AS product_name,
        p.supplier_purchase_price,
        p.supplier_sold_price,
        p.main_image,
        p.stock_quantity,
        sp.id AS supplier_id,
        sp.store_name AS supplier_name,
        sp.logo AS supplier_logo
      FROM Product p
      JOIN SupplierProfile sp ON p.store_id = sp.id
      WHERE p.status = 'active' AND p.stock_quantity > 0
      ORDER BY RAND()
      LIMIT ?
      `,
      [limit]
    );

    const baseURL = process.env.VITE_IMAGE_BASE_URL2 || "https://storensupply.com";

    const formattedProducts = products.map((p) => ({
      product_id: p.product_id,
      product_name: p.product_name,
      supplier_price: p.supplier_purchase_price,
      selling_price: p.supplier_sold_price,
      stock_quantity: p.stock_quantity,
      supplier_id: p.supplier_id,
      supplier_name: p.supplier_name,
      product_image: p.main_image ? `${baseURL}${p.main_image}` : null,
      supplier_logo: p.supplier_logo ? `${baseURL}${p.supplier_logo}` : null,
    }));

    res.json({ success: true, products: formattedProducts });
  } catch (error) {
    console.error("❌ Error fetching products:", error);
    res.status(500).json({ success: false, message: "Failed to load products" });
  }
});

export default router;
