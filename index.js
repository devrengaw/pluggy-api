// index.js — FinanceFlow Bot com integração Supabase + Telegram + IA

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import pluggyClient from "./pluggy.js";
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
    console.error("Erro ao enviar mensagem Telegram:", err);
  }
}

/**
 * Busca o user_id vinculado ao chat_id.
 * Retorna null se o usuário ainda não tiver vínculo.
 */
async function garantirUsuario(chatId) {
  const { data: vinculo } = await supabase
    .from("telegram_users")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();

  return vinculo?.user_id || null;
}

/* ============================================================
 🔑 VINCULAÇÃO /vincular
============================================================ */
async function comandoVincular(chatId, text) {
  const partes = text.split(" ");
  const token = partes[1];

  if (!token) {
    await sendMessage(chatId, "🔑 Envie assim: `/vincular TG-123456`");
    return;
  }

  const { data: reg, error } = await supabase
    .from("telegram_tokens")
    .select("user_id, ativo, valid_until")
    .eq("token", token)
    .maybeSingle();

  if (error || !reg) {
    await sendMessage(chatId, "❌ Código inválido.");
    return;
  }
  if (!reg.ativo || reg.valid_until < new Date().toISOString()) {
    await sendMessage(chatId, "⚠️ Este código já foi usado ou expirou.");
    return;
  }

  // 1️⃣ Vincula chat ↔ user
  const { error: linkErr } = await supabase.from("telegram_users").upsert(
    {
      chat_id: chatId,
      user_id: reg.user_id,
      nome: "Usuário FinanceFlow",
    },
    { onConflict: "chat_id" }
  );
  if (linkErr) {
    await sendMessage(chatId, "⚠️ Não foi possível concluir a vinculação.");
    return;
  }

  // 2️⃣ Desativa token
  await supabase.from("telegram_tokens").update({ ativo: false }).eq("token", token);

  // 3️⃣ Atualiza campo telegram_chat_id no users
  await supabase.from("users").update({ telegram_chat_id: chatId }).eq("id", reg.user_id);

  await sendMessage(chatId, "✅ Sua conta foi vinculada com sucesso! Agora você já pode usar todos os comandos do bot.");
}

/* ============================================================
 💰 COMANDOS FINANCEIROS
============================================================ */
async function comandoEntrada(chatId, text, userId) {
  const parts = text.split(" ");
  const valor = parts[1];
  const descricao = parts.slice(2).join(" ") || "Sem descrição";

  const { error } = await supabase.from("transacoes").insert({
    tipo: "entrada",
    valor,
    descricao,
    chat_id: chatId,
    user_id: userId,
    categoria: "auto", // o trigger no Supabase ajusta para fixa/variável
  });

  if (error) {
    console.error("❌ Erro ao salvar entrada:", error);
    await sendMessage(chatId, "⚠️ Erro ao registrar entrada.");
  } else {
    await sendMessage(chatId, `💰 Entrada registrada: R$${valor}`);
  }
}

async function comandoSaida(chatId, text, userId) {
  const parts = text.split(" ");
  const valor = parts[1];
  const descricao = parts.slice(2).join(" ") || "Sem descrição";
  const metodo = parts[3] || "outros";
  const cartao = metodo === "credito" ? parts[4] || "não informado" : null;

  const { error } = await supabase.from("transacoes").insert({
    tipo: "saida",
    valor,
    descricao,
    metodo,
    cartao,
    chat_id: chatId,
    user_id: userId,
    categoria: "auto", // trigger ajusta
  });

  if (error) {
    console.error("❌ Erro ao salvar saída:", error);
    await sendMessage(chatId, "⚠️ Erro ao registrar saída.");
  } else {
    await sendMessage(chatId, `💸 Saída registrada: R$${valor}`);
  }
}

async function comandoSaldo(chatId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .eq("chat_id", chatId);

  if (error || !data) {
    await sendMessage(chatId, "⚠️ Erro ao buscar saldo.");
    return;
  }

  const saldo = data.reduce(
    (acc, item) => acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor)),
    0
  );
  await sendMessage(chatId, `📊 Saldo atual: R$${saldo.toFixed(2)}`);
}

/* ============================================================
 🧠 COMANDO INTELIGENTE
============================================================ */
async function comandoInteligente(chatId, text) {
  const pergunta = text.trim();
  if (!pergunta) {
    await sendMessage(chatId, "💬 Pode me perguntar algo, tipo: 'Quanto gastei este mês?'");
    return;
  }

  const { data: historico } = await supabase
    .from("conversas")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(10);

  const contexto = (historico || []).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  contexto.push({ role: "user", content: pergunta });

  const { data: transacoes } = await supabase
    .from("transacoes")
    .select("tipo, valor, descricao, metodo, categoria, created_at")
    .eq("chat_id", chatId);

  const resumo =
    transacoes
      ?.map(
        (t) =>
          `${t.tipo}: R$${t.valor} - ${t.descricao} (${t.categoria || "n/a"}) em ${new Date(
            t.created_at
          ).toLocaleDateString("pt-BR")}`
      )
      .join("\n") || "Nenhuma transação registrada.";

  const systemPrompt = `
Você é um assistente financeiro pessoal.
Use uma linguagem natural, amigável e breve.
Transações recentes do usuário:
${resumo}
`;

  try {
    const resposta = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...contexto],
      temperature: 0.3,
    });

    const conteudo = resposta.choices[0].message.content;
    await sendMessage(chatId, `🤖 ${conteudo}`);

    await supabase.from("conversas").insert([
      { chat_id: chatId, role: "user", content: pergunta },
      { chat_id: chatId, role: "assistant", content: conteudo },
    ]);
  } catch (err) {
    console.error("Erro IA:", err);
    await sendMessage(chatId, "⚠️ Erro ao processar pergunta com IA.");
  }
}

/* ============================================================
 🧹 LIMPAR MEMÓRIA
============================================================ */
async function comandoLimpar(chatId) {
  await supabase.from("conversas").delete().eq("chat_id", chatId);
  await sendMessage(chatId, "🧹 Memória limpa com sucesso!");
}

/* ============================================================
 🤖 WEBHOOK TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";

  try {
    // Permite /start e /vincular mesmo sem vínculo
    const isStartOrVincular =
      text.toLowerCase().startsWith("/start") ||
      text.toLowerCase().startsWith("/vincular");

    let userId = null;
    if (!isStartOrVincular) {
      userId = await garantirUsuario(chatId);
      if (!userId) {
        await sendMessage(
          chatId,
          "🔒 Sua conta ainda não está vinculada.\nGere seu token no site e envie aqui:\n`/vincular TG-123456`"
        );
        return res.sendStatus(200);
      }
    }

    if (text.toLowerCase() === "/start") {
      await sendMessage(
        chatId,
        "👋 Olá! Eu sou o assistente financeiro do *FinanceFlow*.\n\n" +
          "Para começar, ative sua conta enviando o código gerado no site:\n" +
          "`/vincular TG-123456`"
      );
    } else if (text.startsWith("/vincular")) await comandoVincular(chatId, text);
    else if (text.startsWith("/entrada")) await comandoEntrada(chatId, text, userId);
    else if (text.startsWith("/saida")) await comandoSaida(chatId, text, userId);
    else if (text === "/saldo") await comandoSaldo(chatId);
    else if (text === "/limpar") await comandoLimpar(chatId);
    else await comandoInteligente(chatId, text);
  } catch (err) {
    console.error("Erro webhook:", err);
    await sendMessage(chatId, "⚠️ Erro inesperado. Tente novamente.");
  }

  res.sendStatus(200);
});

/* ============================================================
 🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
