// index.js
import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import pluggyClient from "./pluggy.js"
import supabase from "./supabase.js"

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

// Healthcheck simples
app.get("/", (req, res) => {
  res.json({ status: "ok" })
})

// ✅ Endpoint que realmente gerou o token Pluggy com sucesso
app.get("/connect-token", async (req, res) => {
  try {
    const connectToken = await pluggyClient.connect.create({
      clientUserId: "user-" + Date.now().toString(),
    })
    res.json(connectToken)
  } catch (error) {
    console.error("Erro ao gerar connect token:", error)
    res.status(500).json({ error: error.message })
  }
})

// ✅ (opcional) Endpoint para listar conexões (caso precise)
app.get('/connect-token', async (req, res) => {
  // ...
  const connectToken = await pluggyClient.connect.createConnectToken(newUser.id);
  res.json(connectToken);
});

// Porta do Render
const port = process.env.PORT || 10000
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`)
})

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// 🔐 Credenciais
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE;

// 🗄️ Conexão Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 📩 Webhook de mensagens do Telegram
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.toLowerCase() || "";

  if (text.startsWith("/entrada")) {
    const valor = text.split(" ")[1];
    const descricao = text.split(" ").slice(2).join(" ") || "Sem descrição";

    await supabase.from("transacoes").insert({
      tipo: "entrada",
      valor,
      descricao,
      chat_id: chatId,
    });

    await sendMessage(chatId, `✅ Entrada registrada: R$${valor} (${descricao})`);
  } 
  else if (text.startsWith("/saida")) {
    const valor = text.split(" ")[1];
    const descricao = text.split(" ").slice(2).join(" ") || "Sem descrição";

    await supabase.from("transacoes").insert({
      tipo: "saida",
      valor,
      descricao,
      chat_id: chatId,
    });

    await sendMessage(chatId, `💸 Saída registrada: R$${valor} (${descricao})`);
  }
  else if (text === "/saldo") {
    const { data } = await supabase
      .from("transacoes")
      .select("tipo, valor")
      .eq("chat_id", chatId);

    const saldo = data.reduce((acc, item) => {
      return acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor));
    }, 0);

    await sendMessage(chatId, `📊 Seu saldo atual é: R$${saldo.toFixed(2)}`);
  } 
  else {
    await sendMessage(chatId, "👋 Olá! Use:\n/entrada 100 descrição\n/saida 50 descrição\n/saldo");
  }

  res.sendStatus(200);
});

// 🔁 Função auxiliar para enviar mensagens
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// 🌐 Inicia o servidor
app.listen(3000, () => console.log("Bot rodando 🚀"));

