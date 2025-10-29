import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

// Inicialização
const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// Variáveis
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

// === TELEGRAM BOT ===
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  console.log("🔔 Mensagem recebida do Telegram:", req.body);
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.trim().toLowerCase() || "";

  // Função para enviar resposta
  async function sendMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  }

  // --- /entrada ---
  if (text.startsWith("/entrada")) {
    const parts = text.split(" ");
    const valor = parts[1];
    const descricao = parts.slice(2).join(" ") || "Sem descrição";

    const { error } = await supabase.from("transacoes").insert({
      tipo: "entrada",
      valor,
      descricao,
      chat_id: chatId,
    });

    if (error) {
      console.error("❌ Erro ao salvar entrada:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar a entrada.");
    } else {
      console.log("✅ Entrada salva no Supabase");
      await sendMessage(chatId, `✅ *Entrada registrada:*\nR$${valor} — ${descricao}`);
    }
    return res.sendStatus(200);
  }

  // --- /saida ---
  if (text.startsWith("/saida")) {
    const parts = text.split(" ");
    const valor = parts[1];
    const descricao = parts[2] || "Sem descrição";
    const metodo = parts[3] || "outros";
    const cartao = metodo === "credito" ? parts[4] || "não informado" : null;

    const { error } = await supabase.from("transacoes").insert({
      tipo: "saida",
      valor,
      descricao,
      metodo,
      cartao,
      chat_id: chatId,
    });

    if (error) {
      console.error("❌ Erro ao salvar saída:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar a saída.");
    } else {
      console.log("✅ Saída salva no Supabase");
      const extra =
        metodo === "credito"
          ? `💳 (${metodo.toUpperCase()} - ${cartao})`
          : `💸 (${metodo})`;
      await sendMessage(chatId, `💸 *Saída registrada:*\nR$${valor} ${extra}\n${descricao}`);
    }

    return res.sendStatus(200);
  }

  // --- /saldo ---
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

    await sendMessage(chatId, `📊 *Seu saldo atual é:*\nR$${saldo.toFixed(2)}`);
    return res.sendStatus(200);
  }

  // --- /resumo ---
  if (text === "/resumo") {
    const { data, error } = await supabase
      .from("transacoes")
      .select("tipo, valor, created_at")
      .eq("chat_id", chatId)
      .gte(
        "created_at",
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      );

    if (error || !data || data.length === 0) {
      await sendMessage(chatId, "📭 Nenhuma transação encontrada nos últimos 7 dias.");
      return res.sendStatus(200);
    }

    const totalEntrada = data
      .filter((t) => t.tipo === "entrada")
      .reduce((acc, t) => acc + Number(t.valor), 0);
    const totalSaida = data
      .filter((t) => t.tipo === "saida")
      .reduce((acc, t) => acc + Number(t.valor), 0);

    const saldo = totalEntrada - totalSaida;

    await sendMessage(
      chatId,
      `📅 *Resumo dos últimos 7 dias:*\n\n💰 Entradas: R$${totalEntrada.toFixed(2)}\n💸 Saídas: R$${totalSaida.toFixed(2)}\n📊 Saldo: R$${saldo.toFixed(2)}`
    );
    return res.sendStatus(200);
  }

  // --- /ajuda ---
  if (text === "/ajuda") {
    await sendMessage(
      chatId,
      "🤖 *Comandos disponíveis:*\n\n" +
        "💰 /entrada [valor] [descrição]\nEx: /entrada 100 salario\n\n" +
        "💸 /saida [valor] [descrição] [método] [cartão]\nEx: /saida 50 mercado credito Nubank\n\n" +
        "📊 /saldo → mostra seu saldo atual\n" +
        "📅 /resumo → resumo dos últimos 7 dias\n" +
        "ℹ️ /ajuda → mostra esta lista"
    );
    return res.sendStatus(200);
  }

  // --- Comando não reconhecido ---
  await sendMessage(
    chatId,
    "👋 Comando não reconhecido.\nUse /ajuda para ver a lista completa de comandos."
  );
  res.sendStatus(200);
});

// Inicialização
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
