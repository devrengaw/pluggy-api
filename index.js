// index.js — FinanceFlow completo com IA, Categorias, Aprendizado, Hub Familiar,
// Teste de 30 dias (Plano PRO), Token Telegram e Realtime Supabase ↔ Telegram ↔ Horizons

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import supabase from "./supabase.js";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js"; // 🔁 Realtime
import { randomUUID } from "crypto";

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
🧠 INTERPRETAÇÃO NATURAL (IA)
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Você é um assistente financeiro.
Classifique o texto como "entrada", "saida", "consulta", "menu", "saldo", "resumo", "extrato", "projecao" ou "outros".
Extraia o valor e uma breve descrição.

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
🧠 MEMÓRIA DE ESSENCIALIDADE
============================================================ */
function extrairPalavrasChave(texto) {
  return texto
    .toLowerCase()
    .split(/[\s,.;:!?()]+/)
    .filter((p) => p.length > 3 && isNaN(p))
    .slice(0, 5);
}

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

/* ============================================================
💡 Heurística: Fixa / Variável / Essencial
============================================================ */
function detectarTipoFixo(descricao) {
  const fixas = ["aluguel", "condominio", "energia", "internet", "telefone", "plano", "mensalidade"];
  const variaveis = ["mercado", "lazer", "restaurante", "compras", "uber", "gasolina", "viagem"];
  const lower = descricao.toLowerCase();
  if (fixas.some((p) => lower.includes(p))) return "fixa";
  if (variaveis.some((p) => lower.includes(p))) return "variavel";
  return "variavel";
}

/* ============================================================
💰 TRANSAÇÕES E RELATÓRIOS
============================================================ */
async function registrarTransacao({ tipo, valor, descricao, chatId, userId, familyId, perguntarEssencial }) {
  const tipo_fixo = detectarTipoFixo(descricao);
  const { data, error } = await supabase
    .from("transacoes")
    .insert({
      tipo,
      valor: Number(valor),
      descricao,
      tipo_fixo,
      categoria: null,
      essencial: null,
      user_id: userId,
      family_id: familyId || null,
      chat_id: chatId.toString(),
    })
    .select("id, tipo")
    .maybeSingle();

  if (error) {
    console.error("Erro ao registrar:", error);
    return await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
  }

  const label = tipo === "entrada" ? "💰 Entrada registrada" : "💸 Saída registrada";
  await sendMessage(chatId, `${label}: R$${valor} — ${descricao}`);

  // 🗂 Categoria
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🍽 Alimentação", callback_data: `cat_${data.id}_alimentacao` },
        { text: "🏠 Moradia", callback_data: `cat_${data.id}_moradia` },
      ],
      [
        { text: "🚗 Transporte", callback_data: `cat_${data.id}_transporte` },
        { text: "🎉 Lazer", callback_data: `cat_${data.id}_lazer` },
      ],
      [
        { text: "💊 Saúde", callback_data: `cat_${data.id}_saude` },
        { text: "💼 Trabalho", callback_data: `cat_${data.id}_trabalho` },
      ],
    ],
  };
  await sendMessage(chatId, "🗂 Escolha uma categoria para essa transação:", replyMarkup);

  // 🧠 Pergunta “essencial” apenas se for SAÍDA
  if (tipo === "saida" && perguntarEssencial) {
    const replyMarkupEss = {
      inline_keyboard: [
        [
          { text: "🟢 Essencial", callback_data: `ess_${data.id}_true` },
          { text: "🔴 Não essencial", callback_data: `ess_${data.id}_false` },
        ],
      ],
    };
    await sendMessage(chatId, "Essa despesa é essencial?", replyMarkupEss);
  }
}

/* ============================================================
🔄 CALLBACKS
============================================================ */
async function definirCategoria(transactionId, categoria, chatId) {
  await supabase.from("transacoes").update({ categoria }).eq("id", transactionId);
  await sendMessage(chatId, `🗂 Categoria registrada como *${categoria}*`);
}

async function definirEssencialidade(transactionId, valor, chatId, userId) {
  const essencial = valor === "true";
  const { data } = await supabase
    .from("transacoes")
    .update({ essencial })
    .eq("id", transactionId)
    .select("descricao")
    .maybeSingle();

  await sendMessage(chatId, essencial ? "🟢 Marcado como *essencial*" : "🔴 Marcado como *não essencial*");
  await atualizarMemoriaEssencial(userId, data.descricao, essencial);
}

/* ============================================================
💬 COMANDOS /start e /menu
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;

  if (body.message) {
    const chatId = body.message.chat.id;
    const text = body.message.text?.trim();

    // 🎉 Boas-vindas
    if (text?.toLowerCase() === "/start") {
      await sendMessage(
        chatId,
        "👋 *Bem-vindo(a) ao FinanceFlow!*\n\n" +
          "Registre seus ganhos e gastos direto pelo Telegram, " +
          "e veja tudo no painel do app.\n\n" +
          "Envie mensagens como:\n" +
          "`+2000 salário` — para registrar uma entrada\n" +
          "`-150 mercado` — para registrar uma saída\n\n" +
          "Use `/menu` para ver as opções e funções disponíveis.\n\n" +
          "Se ainda não conectou sua conta:\n`/vincular TLG-XXXXXX`"
      );
      return res.sendStatus(200);
    }

    // 🧭 Menu
    if (text?.toLowerCase() === "/menu") {
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: "💰 Registrar Entrada", callback_data: "ajuda_entrada" },
            { text: "💸 Registrar Saída", callback_data: "ajuda_saida" },
          ],
          [
            { text: "📊 Ver Resumo no App", callback_data: "ajuda_resumo" },
            { text: "🧠 Como funciona a IA", callback_data: "ajuda_ia" },
          ],
          [{ text: "🔗 Vincular Conta", callback_data: "ajuda_vinculo" }],
        ],
      };
      await sendMessage(chatId, "📋 *Menu de Comandos FinanceFlow*", replyMarkup);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

/* ============================================================
🔁 SUPABASE REALTIME ↔ TELEGRAM ↔ FRONT (sem duplicação)
============================================================ */
const supabaseRealtime = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
supabaseRealtime
  .channel("transacoes_updates")
  .on("postgres_changes", { event: "*", schema: "public", table: "transacoes" }, async (payload) => {
    console.log("📡 Mudança detectada em transações:", payload.eventType, payload.new);
  })
  .subscribe();

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
