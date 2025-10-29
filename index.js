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
app.get('/connect-token', async (req, res) => {
  try {
    const token = await pluggyClient.connectTokens.create();
    res.json(token);
  } catch (error) {
    console.error("Erro ao gerar connect token:", error);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`);
});
