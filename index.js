// index.js — FinanceFlow com IA, Categorias e Aprendizado Adaptativo
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
🔧 FUNÇÕES BASE
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
🧠 APRENDIZADO — FUNÇÕES DE MEMÓRIA
============================================================ */
async function atualizarMemoriaEssencial(userId, descricao, essencial) {
  const palavras = extrairPalavrasChave(descricao);
  for (const palavra of palavras) {
    const { data: existente } = await supabase
      .from("memoria_essenciais")
      .select("*")
      .eq("user_id", userId)
      .eq("palavra", palavra)
      .maybeSingle();

    if (existente) {
      await supabase
        .from("memoria_essenciais")
        .update({
          essencial,
          contagem: existente.contagem + 1,
          ultima_atualizacao: new Date(),
        })
        .eq("id", existente.id);
    } else {
      await supabase.from("memoria_essenciais").insert({
        user_id: userId,
        palavra,
        essencial,
      });
    }
  }
}

function extrairPalavrasChave(texto) {
  return texto
    .toLowerCase()
    .split(/[\s,.;:!?()]+/)
    .filter((p) => p.length > 3 && isNaN(p))
    .slice(0, 5); // máximo 5 palavras
}

async function preverEssencialUsuario(userId, descricao) {
  const palavras = extrairPalavrasChave(descricao);
  for (const palavra of palavras) {
    const { data } = await supabase
      .from("memoria_essenciais")
      .select("essencial")
      .eq("user_id", userId)
      .eq("palavra", palavra)
      .maybeSingle();
    if (data) return data.essencial; // achou uma palavra conhecida
  }
  return null;
}

/* ============================================================
💰 REGISTRO DE TRANSAÇÃO (com aprendizado)
============================================================ */
async function registrarTransacao({
  tipo,
  valor,
  descricao,
  tipo_fixo,
  chatId,
  userId,
  familyId,
  perguntarEssencial,
}) {
  // 1️⃣ Verificar se o usuário já tem histórico de aprendizado
  const aprendizado = await preverEssencialUsuario(userId, descricao);

  // 2️⃣ Se IA pessoal não souber, usar heurística geral
  let essencial = aprendizado;
  if (essencial === null) {
    essencial = preverEssencialHeuristico(descricao);
  }

  // 3️⃣ Inserir transação
  const { data, error } = await supabase
    .from("transacoes")
    .insert({
      tipo,
      valor: Number(valor),
      descricao,
      tipo_fixo,
      essencial,
      user_id: userId,
      family_id: familyId || null,
      chat_id: chatId.toString(),
    })
    .select("id, essencial")
    .maybeSingle();

  if (error) {
    await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
    return;
  }

  await sendMessage(chatId, `✅ ${tipo.toUpperCase()} registrada!\n💰 R$${valor}`);

  // 4️⃣ Perguntar sobre essencialidade, se necessário
  if (perguntarEssencial && data.essencial === null) {
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "🟢 Essencial", callback_data: `ess_${data.id}_true` },
          { text: "🔴 Não essencial", callback_data: `ess_${data.id}_false` },
        ],
      ],
    };
    await sendMessage(chatId, "Essa despesa é essencial ou não essencial?", replyMarkup);
  }
}

/* ============================================================
🧠 Heurística geral (fallback)
============================================================ */
function preverEssencialHeuristico(texto) {
  const lower = texto.toLowerCase();
  const essenciais = ["supermercado", "aluguel", "energia", "luz", "água", "transporte", "mercado", "gasolina"];
  const naoEssenciais = ["cinema", "netflix", "spotify", "restaurante", "bar", "viagem", "lazer"];
  if (essenciais.some((p) => lower.includes(p))) return true;
  if (naoEssenciais.some((p) => lower.includes(p))) return false;
  return null;
}

/* ============================================================
🔄 CALLBACKS — Categoria e Essencialidade
============================================================ */
async function definirEssencialidade(transactionId, valor, chatId, userId) {
  const essencial = valor === "true";
  const { data, error } = await supabase
    .from("transacoes")
    .update({ essencial })
    .eq("id", transactionId)
    .select("descricao")
    .maybeSingle();

  if (error) {
    await sendMessage(chatId, "⚠️ Erro ao atualizar essencialidade.");
  } else {
    await sendMessage(
      chatId,
      essencial ? "🟢 Marcado como *essencial*" : "🔴 Marcado como *não essencial*"
    );
    await atualizarMemoriaEssencial(userId, data.descricao, essencial);
  }
}

/* ============================================================
🤖 WEBHOOK TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;

  // === CALLBACKS ===
  if (body.callback_query) {
    const callback = body.callback_query;
    const chatId = callback.message.chat.id;
    const data = callback.data;
    const userData = await buscarUsuario(chatId);
    const userId = userData?.user_id;

    if (data.startsWith("ess_")) {
      const [_, transacaoId, valor] = data.split("_");
      await definirEssencialidade(transacaoId, valor, chatId, userId);
      await sendCallbackAnswer(callback.id, "Aprendido!");
    }

    return res.sendStatus(200);
  }

  // === MENSAGENS ===
  const msg = body.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return res.sendStatus(200);

  const userData = await buscarUsuario(chatId);
  if (!userData) {
    await sendMessage(chatId, "🔒 Sua conta não está vinculada. Use `/ativar TLG-XXXXXX`");
    return res.sendStatus(200);
  }

  const { user_id, family_id, perguntar_essencial } = userData;

  // Registrar transação simples (IA + aprendizado)
  const acao = text.includes("+") ? "entrada" : text.includes("-") ? "saida" : "outros";
  const valor = parseFloat(text.replace(/[^\d.,]/g, "").replace(",", ".")) || null;
  const descricao = text.replace(/[+-]?\d+[,.]?\d*/g, "").trim();

  if (["entrada", "saida"].includes(acao) && valor) {
    await registrarTransacao({
      tipo: acao,
      valor,
      descricao,
      tipo_fixo: "variavel",
      chatId,
      userId: user_id,
      familyId: family_id,
      perguntarEssencial: perguntar_essencial,
    });
  } else {
    await sendMessage(chatId, "💬 Envie algo como `-300 mercado` ou `+2500 salário`");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
