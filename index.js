// index.js — FinanceFlow integrado ao Hub da Família do Horizons
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
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem para Telegram:", err);
  }
}

async function buscarUsuario(chatId) {
  const { data } = await supabase
    .from("telegram_users")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data?.user_id || null;
}

async function buscarFamilyId(userId) {
  const { data } = await supabase
    .from("users")
    .select("family_id")
    .eq("id", userId)
    .maybeSingle();
  return data?.family_id || null;
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Analise a frase e determine se é uma "entrada", "saida", "consulta" ou "outros".
Extraia também o valor (número) e uma descrição resumida.

Responda em JSON:
{
  "acao": "entrada" | "saida" | "consulta" | "outros",
  "valor": 150.50 ou null,
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
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { acao: "outros", valor: null, descricao: text };
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("⚠️ Erro interpretando mensagem:", err);
    return { acao: "outros", valor: null, descricao: text };
  }
}

/* ============================================================
💰 REGISTROS FINANCEIROS (com suporte ao Hub da Família)
============================================================ */
async function registrarTransacao({ tipo, valor, descricao, chatId, userId }) {
  try {
    const familyId = await buscarFamilyId(userId);

    const insertObj = {
      tipo,
      categoria: "variavel",
      valor,
      descricao,
      chat_id: chatId,
      user_id: userId,
    };

    // 🔗 Vincula ao hub familiar se existir
    if (familyId) insertObj.family_id = familyId;

    const { error } = await supabase.from("transacoes").insert(insertObj);

    if (error) {
      console.error(`❌ Erro ao salvar ${tipo}:`, error);
      await sendMessage(chatId, `⚠️ Erro ao salvar ${tipo}.`);
    } else {
      const label = tipo === "entrada" ? "Entrada" : "Saída";
      await sendMessage(chatId, `${label} registrada: R$${valor}`);
    }
  } catch (err) {
    console.error("⚠️ Erro ao registrar transação:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro ao registrar a transação.");
  }
}

/* ============================================================
🧮 CONSULTAS / SALDO via IA
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
Transações recentes do usuário:
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
    console.error("Erro IA consulta:", err);
    await sendMessage(chatId, "⚠️ Erro ao responder sua pergunta.");
  }
}

/* ============================================================
🤖 WEBHOOK TELEGRAM — conversa natural + hub
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) return res.sendStatus(200);

  console.log("💬 Mensagem recebida:", text);

  const userId = await buscarUsuario(chatId);
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

    if (["entrada", "saida"].includes(interpretacao.acao) && interpretacao.valor) {
      await registrarTransacao({
        tipo: interpretacao.acao,
        valor: interpretacao.valor,
        descricao: interpretacao.descricao,
        chatId,
        userId,
      });
    } else if (interpretacao.acao === "consulta") {
      await responderConsulta(chatId, text);
    } else {
      await sendMessage(chatId, "💬 Não entendi como transação. Pode tentar novamente?");
    }
  } catch (err) {
    console.error("Erro geral:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro inesperado.");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
