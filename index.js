import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import PluggyClient from "pluggy-sdk";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Pluggy
const pluggy = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET
});

app.get("/", async (req, res) => {
  try {
    const connectors = await pluggy.fetchConnectors();
    res.json(connectors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
