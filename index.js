import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./api/auth.js";
import sellerRoutes from "./api/seller.js";
import supplierRoutes from "./api/supplier.js";
//import { SpeedInsights } from "@vercel/speed-insights/next"
import supplierProductRoutes from "./api/supplierProduct.js";


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
//app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

export default app;