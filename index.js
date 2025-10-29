import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// 🔹 Função utilitária para enviar mensagens ao Telegram
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// 🔹 Função para calcular saldo total
async function calcularSaldo(chatId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .eq("chat_id", chatId);

  if (error || !data) return null;

  const saldo = data.reduce((acc, item) => {
    return acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor));
  }, 0);

  return saldo.toFixed(2);
}

// ============================
// 💰 COMANDOS DO TELEGRAM
// ============================

async function comandoEntrada(chatId, text) {
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
    await sendMessage(chatId, `✅ *Entrada registrada:*\nR$${valor} — ${descricao}`);
  }
}

async function comandoSaida(chatId, text) {
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
    const extra =
      metodo === "credito"
        ? `💳 (${metodo.toUpperCase()} - ${cartao})`
        : `💸 (${metodo})`;
    await sendMessage(chatId, `💸 *Saída registrada:*\nR$${valor} ${extra}\n${descricao}`);
  }
}

async function comandoSaldo(chatId) {
  const saldo = await calcularSaldo(chatId);
  if (saldo === null) {
    await sendMessage(chatId, "⚠️ Erro ao buscar saldo.");
  } else {
    await sendMessage(chatId, `📊 *Seu saldo atual é:*\nR$${saldo}`);
  }
}

async function comandoResumo(chatId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor, created_at")
    .eq("chat_id", chatId)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  if (error || !data || data.length === 0) {
    await sendMessage(chatId, "📭 Nenhuma transação nos últimos 7 dias.");
    return;
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
    `📅 *Resumo dos últimos 7 dias:*\n\n💰 Entradas: R$${totalEntrada.toFixed(
      2
    )}\n💸 Saídas: R$${totalSaida.toFixed(2)}\n📊 Saldo: R$${saldo.toFixed(2)}`
  );
}

async function comandoExtrato(chatId) {
  const mesAtual = new Date().toISOString().slice(0, 7); // formato YYYY-MM
  const { data, error } = await supabase
    .from("transacoes")
    .select("*")
    .eq("chat_id", chatId)
    .gte("created_at", `${mesAtual}-01`)
    .lte("created_at", `${mesAtual}-31`);

  if (error || !data || data.length === 0) {
    await sendMessage(chatId, "📭 Nenhuma transação registrada neste mês.");
    return;
  }

  const lista = data
    .map((t) => {
      const dataFormatada = new Date(t.created_at).toLocaleDateString("pt-BR");
      const simbolo = t.tipo === "entrada" ? "💰" : "💸";
      return `${simbolo} ${dataFormatada} — R$${t.valor} (${t.descricao})`;
    })
    .join("\n");

  const totalEntradas = data
    .filter((t) => t.tipo === "entrada")
    .reduce((acc, t) => acc + Number(t.valor), 0);
  const totalSaidas = data
    .filter((t) => t.tipo === "saida")
    .reduce((acc, t) => acc + Number(t.valor), 0);
  const saldo = totalEntradas - totalSaidas;

  await sendMessage(
    chatId,
    `📆 *Extrato do mês atual:*\n\n${lista}\n\n💰 Total Entradas: R$${totalEntradas.toFixed(
      2
    )}\n💸 Total Saídas: R$${totalSaidas.toFixed(2)}\n📊 Saldo: R$${saldo.toFixed(2)}`
  );
}

async function comandoAjuda(chatId) {
  await sendMessage(
    chatId,
    "🤖 *Comandos disponíveis:*\n\n" +
      "💰 /entrada [valor] [descrição]\nEx: /entrada 100 salario\n\n" +
      "💸 /saida [valor] [descrição] [método] [cartão]\nEx: /saida 50 mercado credito Nubank\n\n" +
      "📊 /saldo → mostra seu saldo atual\n" +
      "📅 /resumo → resumo dos últimos 7 dias\n" +
      "📆 /extrato → extrato do mês atual\n" +
      "ℹ️ /ajuda → lista todos os comandos"
  );
}

// ============================
// 🤖 ROTEAMENTO DO TELEGRAM
// ============================
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.trim().toLowerCase() || "";

  try {
    if (text.startsWith("/entrada")) await comandoEntrada(chatId, text);
    else if (text.startsWith("/saida")) await comandoSaida(chatId, text);
    else if (text === "/saldo") await comandoSaldo(chatId);
    else if (text === "/resumo") await comandoResumo(chatId);
    else if (text === "/extrato") await comandoExtrato(chatId);
    else if (text === "/ajuda") await comandoAjuda(chatId);
    else
      await sendMessage(
        chatId,
        "👋 Comando não reconhecido.\nUse /ajuda para ver a lista completa."
      );
  } catch (err) {
    console.error("Erro geral no webhook:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro inesperado.");
  }

  res.sendStatus(200);
});

// ============================
// 🚀 PLUGGY (ainda funcional)
// ============================
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

// ============================
// 🌐 SERVER START
// ============================
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
