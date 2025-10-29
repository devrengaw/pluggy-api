import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// 🔐 Variáveis
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Healthcheck
app.get("/", (req, res) => res.json({ status: "ok" }));

// === PLUGGY ===
app.get("/connect-token", async (req, res) => {
  try {
    const connectToken = await pluggyClient.connect.create({
      clientUserId: "user-" + Date.now().toString(),
    });
    res.json(connectToken);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === TELEGRAM ===
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  console.log("🔔 Mensagem recebida do Telegram:", req.body);
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.toLowerCase() || "";

  if (text.startsWith("/entrada")) {
    return res.json({ status: "ok", message: "Entrada recebida" });
  } else {
    return res.json({ status: "ok", message: "Comando não reconhecido" });
  }
});

// === Inicialização ===
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
