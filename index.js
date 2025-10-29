import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

// 🔧 Inicialização
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

  // Função para responder no Telegram
  async function sendMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  if (text.startsWith("/entrada")) {
    const valor = text.split(" ")[1];
    const descricao = text.split(" ").slice(2).join(" ") || "Sem descrição";

    const { error } = await supabase.from("transacoes").insert({
      tipo: "entrada",
      valor,
      descricao,
      chat_id: chatId,
    });

    if (error) {
      console.error("❌ Erro ao salvar entrada:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar a entrada no banco de dados.");
    } else {
      console.log("✅ Entrada salva no Supabase");
      await sendMessage(chatId, `✅ Entrada registrada: R$${valor} (${descricao})`);
    }
    return res.sendStatus(200);
  }

  if (text.startsWith("/saida")) {
    const valor = text.split(" ")[1];
    const descricao = text.split(" ").slice(2).join(" ") || "Sem descrição";

    const { error } = await supabase.from("transacoes").insert({
      tipo: "saida",
      valor,
      descricao,
      chat_id: chatId,
    });

    if (error) {
      console.error("❌ Erro ao salvar saída:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar a saída no banco de dados.");
    } else {
      console.log("✅ Saída salva no Supabase");
      await sendMessage(chatId, `💸 Saída registrada: R$${valor} (${descricao})`);
    }
    return res.sendStatus(200);
  }

  if (text === "/saldo") {
    const { data, error } = await supabase
      .from("transacoes")
      .select("tipo, valor")
      .eq("chat_id", chatId);

    if (error || !data) {
      console.error("❌ Erro ao buscar saldo:", error);
      await sendMessage(chatId, "⚠️ Erro ao buscar saldo.");
      return res.sendStatus(200);
    }

    if (data.length === 0) {
      await sendMessage(chatId, "📭 Nenhuma transação encontrada ainda.");
      return res.sendStatus(200);
    }

    const saldo = data.reduce((acc, item) => {
      return acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor));
    }, 0);

    await sendMessage(chatId, `📊 Seu saldo atual é: R$${saldo.toFixed(2)}`);
    return res.sendStatus(200);
  }

  await sendMessage(chatId, "👋 Use:\n/entrada 100 descricao\n/saida 50 descricao\n/saldo");
  res.sendStatus(200);
});

// === Inicialização ===
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
