// api/supplierProfile.js
import express from "express";
import pool from "../db.js";

const router = express.Router();

// ============================
// 1️⃣ Get Public Supplier Profile (No Auth Required)
// ============================
router.get("/:supplierId", async (req, res) => {
  const { supplierId } = req.params;

  try {
    console.log("👤 Fetching public profile for supplier ID:", supplierId);

    // Get Supplier Profile with User info
    const [supplierProfile] = await pool.query(
      `SELECT 
         sp.id,
         sp.store_name,
         sp.store_description,
         sp.logo,
         sp.whatsapp_number,
         sp.is_verified,
         sp.rating,
         sp.total_products,
         sp.country,
         sp.created_at,
         u.username,
         u.email
       FROM SupplierProfile sp
       JOIN User u ON sp.user_id = u.id
       WHERE sp.id = ? AND u.is_active = TRUE`,
      [supplierId]
    );

    if (supplierProfile.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found"
      });
    }

    const supplier = supplierProfile[0];

    // Get Total Products Count
    const [[productCount]] = await pool.query(
      `SELECT COUNT(*) as count FROM Product WHERE store_id = ? AND status = 'active'`,
      [supplierId]
    );

    // Get Products List (active only)
    const [products] = await pool.query(
      `SELECT 
         id,
         title,
         main_image,
         supplier_sold_price,
         stock_quantity,
         category,
         views_count,
         created_at
       FROM Product
       WHERE store_id = ? AND status = 'active'
       ORDER BY created_at DESC`,
      [supplierId]
    );

    // Get Average Rating from Reviews
    const [[avgRating]] = await pool.query(
      `SELECT 
         IFNULL(AVG(rating), 0) as avg_rating,
         COUNT(*) as review_count
       FROM Review
       WHERE store_id = ? AND review_type = 'supplier'`,
      [supplierId]
    );

    // Increment view count (optional analytics)
    // You can add a ProfileView table if needed

    console.log(`✅ Profile loaded: ${supplier.store_name}, ${products.length} products`);

    res.json({
      success: true,
      supplier: {
        id: supplier.id,
        store_name: supplier.store_name,
        store_description: supplier.store_description,
        logo: supplier.logo,
        whatsapp_number: supplier.whatsapp_number,
        is_verified: supplier.is_verified,
        rating: parseFloat(avgRating.avg_rating).toFixed(1),
        review_count: avgRating.review_count,
        total_products: productCount.count,
        country: supplier.country,
        member_since: supplier.created_at,
        username: supplier.username
      },
      products
    });

  } catch (err) {
    console.error("❌ Supplier Profile Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load supplier profile",
      error: err.message
    });
  }
});

// ============================
// 2️⃣ Get Single Product Details (Public)
// ============================
router.get("/:supplierId/product/:productId", async (req, res) => {
  const { supplierId, productId } = req.params;

  try {
    console.log(`📦 Fetching product ${productId} from supplier ${supplierId}`);

    // Get Product Details
    const [products] = await pool.query(
      `SELECT 
         p.*,
         sp.store_name,
         sp.whatsapp_number,
         sp.is_verified,
         sp.logo as store_logo,
         sp.country as store_country
       FROM Product p
       JOIN SupplierProfile sp ON p.store_id = sp.id
       WHERE p.id = ? AND p.store_id = ? AND p.status = 'active'`,
      [productId, supplierId]
    );

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    const product = products[0];

    // Get Additional Product Images
    const [images] = await pool.query(
      `SELECT id, image_url, is_primary
       FROM ProductImage
       WHERE product_id = ?
       ORDER BY is_primary DESC, id ASC`,
      [productId]
    );

    // Get Product Reviews
    const [reviews] = await pool.query(
      `SELECT 
         r.id,
         r.rating,
         r.comment,
         r.reply,
         r.created_at,
         u.username
       FROM Review r
       JOIN User u ON r.user_id = u.id
       WHERE r.product_id = ? AND r.review_type = 'product'
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [productId]
    );

    // Get Average Rating
    const [[avgRating]] = await pool.query(
      `SELECT 
         IFNULL(AVG(rating), 0) as avg_rating,
         COUNT(*) as review_count
       FROM Review
       WHERE product_id = ? AND review_type = 'product'`,
      [productId]
    );

    // Increment view count
    await pool.query(
      `UPDATE Product SET views_count = views_count + 1 WHERE id = ?`,
      [productId]
    );

    console.log(`✅ Product loaded: ${product.title}`);

    res.json({
      success: true,
      product: {
        id: product.id,
        title: product.title,
        description: product.store_description || "No description available",
        main_image: product.main_image,
        price: product.supplier_sold_price,
        purchase_price: product.supplier_purchase_price,
        stock_quantity: product.stock_quantity,
        category: product.category,
        country: product.country,
        ebay_link: product.ebay_link,
        status: product.status,
        views_count: product.views_count + 1,
        created_at: product.created_at,
        avg_rating: parseFloat(avgRating.avg_rating).toFixed(1),
        review_count: avgRating.review_count,
        store: {
          id: supplierId,
          name: product.store_name,
          logo: product.store_logo,
          whatsapp: product.whatsapp_number,
          is_verified: product.is_verified,
          country: product.store_country
        }
      },
      images,
      reviews
    });

  } catch (err) {
    console.error("❌ Product Details Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load product details",
      error: err.message
    });
  }
});

// ============================
// 3️⃣ Search Products in Store (Public)
// ============================
router.get("/:supplierId/search", async (req, res) => {
  const { supplierId } = req.params;
  const { query, category, minPrice, maxPrice, sort = "recent" } = req.query;

  try {
    console.log(`🔍 Searching products in store ${supplierId}`);

    let sql = `
      SELECT 
        id,
        title,
        main_image,
        supplier_sold_price,
        stock_quantity,
        category,
        views_count,
        created_at
      FROM Product
      WHERE store_id = ? AND status = 'active'
    `;
    const params = [supplierId];

    // Search by title
    if (query) {
      sql += ` AND title LIKE ?`;
      params.push(`%${query}%`);
    }

    // Filter by category
    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    // Filter by price range
    if (minPrice) {
      sql += ` AND supplier_sold_price >= ?`;
      params.push(parseFloat(minPrice));
    }
    if (maxPrice) {
      sql += ` AND supplier_sold_price <= ?`;
      params.push(parseFloat(maxPrice));
    }

    // Sorting
    switch (sort) {
      case "price_low":
        sql += ` ORDER BY supplier_sold_price ASC`;
        break;
      case "price_high":
        sql += ` ORDER BY supplier_sold_price DESC`;
        break;
      case "popular":
        sql += ` ORDER BY views_count DESC`;
        break;
      case "recent":
      default:
        sql += ` ORDER BY created_at DESC`;
        break;
    }

    const [products] = await pool.query(sql, params);

    console.log(`✅ Found ${products.length} products`);

    res.json({
      success: true,
      count: products.length,
      products
    });

  } catch (err) {
    console.error("❌ Search Error:", err);
    res.status(500).json({
      success: false,
      message: "Search failed",
      error: err.message
    });
  }
});

// ============================
// 4️⃣ Get Store Categories (Public)
// ============================
router.get("/:supplierId/categories", async (req, res) => {
  const { supplierId } = req.params;

  try {
    const [categories] = await pool.query(
      `SELECT 
         category,
         COUNT(*) as product_count
       FROM Product
       WHERE store_id = ? AND status = 'active'
       GROUP BY category
       ORDER BY product_count DESC`,
      [supplierId]
    );

    res.json({
      success: true,
      categories
    });

  } catch (err) {
    console.error("❌ Categories Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load categories",
      error: err.message
    });
  }
});

export default router;