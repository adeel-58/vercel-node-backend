// backend/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Import Routes
import authRoutes from "./api/auth.js";
import sellerRoutes from "./api/seller.js";
import supplierRoutes from "./api/supplier.js";
import supplierProductRoutes from "./api/supplierProduct.js";
import salesRoutes from "./api/salesRoutes.js";
import dashboardRoutes from "./api/dashboard.js";
import analyticsRoutes from "./api/analytics.js";
import supplierProfileRoutes from "./api/supplierProfile.js";
import publicProductsRoutes from "./api/publicProducts.js";
import shopRoutes from "./api/shop.js";
dotenv.config();

const app = express();

// ✅ Security + Performance Middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://storensupply.com",
      "https://www.storensupply.com",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

//app.options("*", cors()); // Important for PATCH and DELETE
app.use(express.json({ limit: "10mb" }));
// ✅ Health Check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Server is running ✅",
    timestamp: new Date().toISOString(),
  });
});

// ✅ API Routes
app.use("/api/auth", authRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api/supplier", supplierRoutes);
app.use("/api/product", supplierProductRoutes); // Supplier products
app.use("/api/sales", salesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/supplier-profile", supplierProfileRoutes);
app.use("/api/products", publicProductsRoutes); // Public product list
app.use("/api/shop", shopRoutes);
// ✅ Serve media files from FTP fallback uploads folder
app.use("/uploads", express.static("uploads"));

// ✅ Global Error Handler (important)
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.message);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

export default app;
