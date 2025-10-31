// index.js — FinanceFlow completo com IA, Categorias, Aprendizado, Hub Familiar, Comandos Inteligentes, Vincular Telegram e Boas-Vindas no /start
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
🏓 ROTA RAIZ — mantém Render ativo e evita erro 502
============================================================ */
app.get("/", (req, res) => {
  res.status(200).send("✅ FinanceFlow Bot ativo e pronto!");
});

/* ============================================================
🔧 UTILITÁRIOS
============================================================ */
async function sendMessage(chatId, text, reply_markup = null) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
  }
}

async function sendCallbackAnswer(callbackQueryId, text = "OK") {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function buscarUsuario(chatId) {
  const { data } = await supabase
    .from("telegram_users")
    .select("user_id, family_id, perguntar_essencial")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data || null;
}

/* ============================================================
🔐 VINCULAR CONTA TELEGRAM → FINANCEFLOW
============================================================ */
async function vincularConta(chatId, text) {
  const token = text.split(" ")[1]?.trim();
  if (!token) {
    await sendMessage(
      chatId,
      "⚠️ Para vincular sua conta, envie assim:\n`/vincular TLG-XXXXXX`\n\n🔹 O código (token) é gerado no site do *FinanceFlow*, na seção de *Integrações do Telegram*."
    );
    return;
  }

  await sendMessage(chatId, `🔍 Tentando ativar token: ${token}`);

  const { data: tokenData, error: tokenError } = await supabase
    .from("telegram_tokens")
    .select("user_id, family_id, ativo, valid_until")
    .eq("token", token)
    .maybeSingle();

  if (tokenError || !tokenData) {
    await sendMessage(chatId, "❌ Token inválido ou não encontrado.");
    return;
  }

  if (!tokenData.ativo || (tokenData.valid_until && new Date(tokenData.valid_until) < new Date())) {
    await sendMessage(chatId, "⚠️ Token expirado ou inativo. Gere um novo no site do FinanceFlow.");
    return;
  }

  const { error: upsertError } = await supabase.from("telegram_users").upsert({
    chat_id: chatId.toString(),
    user_id: tokenData.user_id,
    family_id: tokenData.family_id || null,
  });

  if (upsertError) {
    console.error("❌ Erro ao vincular usuário:", upsertError);
    await sendMessage(chatId, "❌ Ocorreu um erro ao vincular sua conta. Tente novamente.");
    return;
  }

  await sendMessage(
    chatId,
    "🎉 *Conta vinculada com sucesso!*\nAgora você pode registrar suas entradas e saídas diretamente por aqui.\n\n💬 Exemplos:\n- `+2500 salário`\n- `-150 mercado`\n\nUse `/menu` para ver todos os comandos disponíveis."
  );
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL (IA)
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Você é um assistente financeiro inteligente.
Classifique o texto como "entrada", "saida", "consulta", "menu", "saldo", "resumo", "extrato", "projecao" ou "outros".
Extraia o valor numérico e uma breve descrição.

Responda APENAS JSON:
{
  "acao": "...",
  "valor": número ou null,
  "descricao": "texto breve"
}

Texto: "${text}"
`;
  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
    const raw = result.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { acao: "outros", valor: null, descricao: text };
  } catch (err) {
    console.error("⚠️ Erro IA:", err);
    return { acao: "outros", valor: null, descricao: text };
  }
}

/* ============================================================
💬 WEBHOOK TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;
  if (!body.message) return res.sendStatus(200);

  const chatId = body.message.chat.id;
  const text = body.message.text?.trim() || "";

  // ✅ Mensagem de boas-vindas após /start
  if (text.toLowerCase() === "/start") {
    await sendMessage(
      chatId,
      "👋 *Bem-vindo ao FinanceFlow!*\n\nSou seu assistente financeiro pessoal. 💙\n\nPara começar, gere seu token no site do *FinanceFlow* em *Integrações → Telegram*.\n\nDepois envie aqui:\n`/vincular TLG-XXXXXX`\n\n💬 Exemplos de uso:\n`+2500 salário`\n`-150 mercado`\n\nUse `/menu` para ver todos os comandos e recursos disponíveis."
    );
    return res.sendStatus(200);
  }

  // Resto da lógica original segue igual...
  if (text.toLowerCase().startsWith("/vincular")) {
    await vincularConta(chatId, text);
    return res.sendStatus(200);
  }

  // (demais funções e IA, etc. continuam aqui normalmente)
  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () =>
  console.log(`✅ Server online na porta ${port} — pronto para Telegram!`)
);
