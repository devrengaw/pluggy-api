// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck simples
app.get("/api/create-link-token", async (req, res) => {
  try {
    const response = await pluggyClient.api.connectToken.create();
    res.json(response);
  } catch (err) {
    console.error("Erro ao gerar connect token:", err);
    res.status(500).json({ error: err.message });
  }
});
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`);
});
