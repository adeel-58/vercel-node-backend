import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./api/auth.js";
import sellerRoutes from "./api/seller.js";
import supplierRoutes from "./api/supplier.js";
//import { SpeedInsights } from "@vercel/speed-insights/next"
import supplierProductRoutes from "./api/supplierProduct.js";
import salesRoutes from "./api/salesRoutes.js";
import dashboardRoutes from "./api/dashboard.js";
import analyticsRoutes from "./api/analytics.js";
// backend/index.js
import supplierProfileRoutes from "./api/supplierProfile.js";
import publicProductsRoutes from "./api/publicProducts.js";
// Add this line with your other routes


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    success: true, 
    message: "Server is running",
    timestamp: new Date().toISOString()
  });
});

// Authentication Routes
app.use("/api/auth", authRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api/supplier", supplierRoutes);
app.use("/api/product", supplierProductRoutes); // ✅ renamed from /api/supplierProduct
app.use("/uploads", express.static("uploads")); // ✅ serves product images
app.use("/api/sales", salesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/supplier-profile", supplierProfileRoutes);
app.use("/api/products", publicProductsRoutes);



//app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

export default app;