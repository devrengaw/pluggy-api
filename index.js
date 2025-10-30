// index.js — FinanceFlow com suporte a Hub Familiar e uso individual
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
🔧 FUNÇÕES BÁSICAS
============================================================ */
async function sendMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
  }
}

async function buscarUsuario(chatId) {
  const { data } = await supabase
    .from("telegram_users")
    .select("user_id, family_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data || null;
}

/* ============================================================
🔑 ATIVAÇÃO (/ativar ou /vincular)
============================================================ */
async function comandoAtivar(chatId, text) {
  const partes = text.trim().split(/\s+/);
  const token = partes[1]?.trim();

  if (!token) {
    await sendMessage(chatId, "🔑 Envie o comando assim: `/ativar TG-123456`");
    return;
  }

  const { data: reg, error } = await supabase
    .from("telegram_tokens")
    .select("user_id, ativo, valid_until")
    .eq("token", token)
    .maybeSingle();

  if (error || !reg) {
    await sendMessage(chatId, "❌ Código inválido. Gere um novo token no site.");
    return;
  }

  if (!reg.ativo) {
    await sendMessage(chatId, "⚠️ Este código já foi utilizado ou está desativado.");
    return;
  }

  const now = new Date();
  const validade = new Date(reg.valid_until);
  if (validade < now) {
    await sendMessage(chatId, "⌛ Este código expirou. Gere um novo no site.");
    return;
  }

  // 🔗 Vincular chat ↔ user (função SQL já sincroniza family_id)
  const { error: linkErr } = await supabase.from("telegram_users").upsert(
    {
      chat_id: chatId,
      user_id: reg.user_id,
      nome: "Usuário FinanceFlow",
    },
    { onConflict: "chat_id" }
  );
  if (linkErr) {
    console.error("Erro ao vincular:", linkErr);
    await sendMessage(chatId, "⚠️ Falha ao vincular sua conta. Tente novamente.");
    return;
  }

  await supabase.from("telegram_tokens").update({ ativo: false }).eq("token", token);
  await supabase.from("users").update({ telegram_chat_id: chatId }).eq("id", reg.user_id);

  await sendMessage(chatId, "✅ Sua conta foi vinculada com sucesso! Agora você já pode usar todos os comandos.");
}

/* ============================================================
💡 INTERPRETAÇÃO NATURAL
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Analise a frase e determine se é uma "entrada", "saida", "consulta" ou "outros".
Extraia também o valor (número) e uma descrição resumida.

Responda em JSON:
{"acao": "...", "valor": 0, "descricao": "..."}

Frase: "${text}"
`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });
    const match = result.choices[0].message.content.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { acao: "outros", valor: null, descricao: text };
  } catch (err) {
    console.error("Erro IA interpretação:", err);
    return { acao: "outros", valor: null, descricao: text };
  }
}

/* ============================================================
💰 REGISTRO FINANCEIRO (com ou sem família)
============================================================ */
async function registrarTransacao({ tipo, valor, descricao, chatId, userId, familyId }) {
  const transacao = {
    tipo,
    valor,
    descricao,
    chat_id: chatId,
    user_id: userId,
  };
  if (familyId) transacao.family_id = familyId;

  const { error } = await supabase.from("transacoes").insert(transacao);
  if (error) {
    console.error("Erro ao salvar:", error);
    await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
  } else {
    const label = tipo === "entrada" ? "Entrada" : "Saída";
    await sendMessage(chatId, `${label} registrada: R$${valor}`);
  }
}

/* ============================================================
🧮 CONSULTA COM IA
============================================================ */
async function responderConsulta(chatId, text, familyId, userId) {
  const filtro = familyId ? { family_id: familyId } : { user_id: userId };
  const { data } = await supabase.from("transacoes").select("*").match(filtro);

  const resumo =
    data?.map(
      (t) =>
        `${t.tipo}: R$${t.valor} - ${t.descricao} (${new Date(
          t.created_at
        ).toLocaleDateString("pt-BR")})`
    ).join("\n") || "Sem transações registradas.";

  const prompt = `
Você é um assistente financeiro.
Transações:
${resumo}

Pergunta: "${text}"
Responda em português, curto e direto.
`;

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  await sendMessage(chatId, `🤖 ${result.choices[0].message.content}`);
}

/* ============================================================
🤖 WEBHOOK TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  console.log("💬 Mensagem recebida:", text);

  if (text.toLowerCase().startsWith("/ativar") || text.toLowerCase().startsWith("/vincular")) {
    await comandoAtivar(chatId, text);
    return res.sendStatus(200);
  }

  const userData = await buscarUsuario(chatId);
  if (!userData) {
    await sendMessage(chatId, "🔒 Sua conta não está vinculada. Gere um token no site e envie `/ativar TG-123456`");
    return res.sendStatus(200);
  }

  const { user_id, family_id } = userData;
  const interpret = await interpretarMensagem(text);

  if (["entrada", "saida"].includes(interpret.acao) && interpret.valor) {
    await registrarTransacao({
      tipo: interpret.acao,
      valor: interpret.valor,
      descricao: interpret.descricao,
      chatId,
      userId: user_id,
      familyId: family_id,
    });
  } else if (interpret.acao === "consulta") {
    await responderConsulta(chatId, text, family_id, user_id);
  } else {
    await sendMessage(chatId, "💬 Não entendi bem. Pode tentar novamente?");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
