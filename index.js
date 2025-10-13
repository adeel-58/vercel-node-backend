import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./api/auth.js";
import sellerRoutes from "./api/seller.js";
//import { SpeedInsights } from "@vercel/speed-insights/next"

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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

export default app;