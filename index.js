// index.js - versão natural completa e atualizada
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import supabase from "./supabase.js";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ============================================================
🔧 UTILITÁRIOS
============================================================ */
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function garantirUsuario(chatId) {
  const { data } = await supabase
    .from("telegram_users")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data?.user_id || null;
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Analise a frase e determine:
1️⃣ Se é uma "entrada" (dinheiro recebido), "saida" (gasto), "consulta" (pergunta) ou "outros".
2️⃣ Extraia o valor e a descrição.

Responda em JSON no formato:
{
  "acao": "entrada" | "saida" | "consulta" | "outros",
  "valor": 1200 ou null,
  "descricao": "texto breve"
}

Frase: "${text}"
`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    const raw = result.choices[0].message.content.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { acao: "outros", valor: null, descricao: text };
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Erro interpretando mensagem:", err);
    return { acao: "outros", valor: null, descricao: text };
  }
}

/* ============================================================
💰 REGISTROS FINANCEIROS
============================================================ */
async function registrarEntrada(chatId, userId, valor, descricao) {
  const { error } = await supabase.from("transacoes").insert({
    tipo: "entrada",
    categoria: "variavel",
    valor,
    descricao,
    chat_id: chatId,
    user_id: userId,
  });
  if (error) {
    console.error("❌ Erro ao salvar entrada:", error);
    await sendMessage(chatId, "⚠️ Erro ao salvar entrada.");
  } else {
    await sendMessage(chatId, `Entrada registrada: R$${valor}`);
  }
}

async function registrarSaida(chatId, userId, valor, descricao) {
  const { error } = await supabase.from("transacoes").insert({
    tipo: "saida",
    categoria: "variavel",
    valor,
    descricao,
    chat_id: chatId,
    user_id: userId,
  });
  if (error) {
    console.error("❌ Erro ao salvar saída:", error);
    await sendMessage(chatId, "⚠️ Erro ao salvar saída.");
  } else {
    await sendMessage(chatId, `Saída registrada: R$${valor}`);
  }
}

/* ============================================================
🧮 CONSULTAS E SALDO
============================================================ */
async function responderConsulta(chatId, text) {
  const { data } = await supabase
    .from("transacoes")
    .select("tipo, valor, descricao, created_at")
    .eq("chat_id", chatId);

  const resumo =
    data?.map(
      (t) =>
        `${t.tipo}: R$${t.valor} - ${t.descricao} (${new Date(
          t.created_at
        ).toLocaleDateString("pt-BR")})`
    ).join("\n") || "Sem transações registradas.";

  const prompt = `
Você é um assistente financeiro.  
Transações do usuário:
${resumo}

Pergunta: "${text}"  
Responda de forma curta, direta e em português.
`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const resposta = result.choices[0].message.content;
    await sendMessage(chatId, `🤖 ${resposta}`);
  } catch (err) {
    console.error("Erro na consulta IA:", err);
    await sendMessage(chatId, "⚠️ Erro ao responder sua consulta.");
  }
}

/* ============================================================
🤖 WEBHOOK TELEGRAM — modo natural total
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) return res.sendStatus(200);

  console.log("💬 Mensagem recebida:", text);

  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(
      chatId,
      "🔒 Sua conta ainda não está vinculada. Gere seu token no site e envie `/ativar TG-123456`"
    );
    return res.sendStatus(200);
  }

  try {
    const interpretacao = await interpretarMensagem(text);
    console.log("🧠 Interpretação:", interpretacao);

    if (interpretacao.acao === "entrada" && interpretacao.valor) {
      await registrarEntrada(chatId, userId, interpretacao.valor, interpretacao.descricao);
    } else if (interpretacao.acao === "saida" && interpretacao.valor) {
      await registrarSaida(chatId, userId, interpretacao.valor, interpretacao.descricao);
    } else if (interpretacao.acao === "consulta") {
      await responderConsulta(chatId, text);
    } else {
      console.log("💭 Mensagem sem ação detectada:", text);
      await sendMessage(chatId, "💬 Mensagem registrada, mas não identifiquei uma ação financeira clara.");
    }
  } catch (err) {
    console.error("Erro geral:", err);
    await sendMessage(chatId, "⚠️ Erro ao processar sua mensagem.");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
