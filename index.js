// index.js — FinanceFlow com IA e Hub Familiar
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
    console.error("❌ Erro ao enviar mensagem para Telegram:", err);
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
🔑 ATIVAÇÃO DO TELEGRAM (/ativar ou /vincular)
============================================================ */
async function comandoAtivar(chatId, text) {
  const partes = text.trim().split(/\s+/);
  const token = partes[1]?.trim();

  if (!token) {
    await sendMessage(chatId, "🔑 Envie o comando assim: `/ativar TLG-123456`");
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
    await sendMessage(chatId, "⚠️ Este código já foi usado ou está desativado.");
    return;
  }

  const now = new Date();
  const validade = new Date(reg.valid_until);
  if (validade < now) {
    await sendMessage(chatId, "⌛ Este código expirou. Gere um novo no site.");
    return;
  }

  // Vincula chat ↔ user
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
    await sendMessage(chatId, "⚠️ Falha ao vincular sua conta.");
    return;
  }

  await supabase.from("telegram_tokens").update({ ativo: false }).eq("token", token);
  await supabase.from("users").update({ telegram_chat_id: chatId }).eq("id", reg.user_id);

  await sendMessage(chatId, "✅ Sua conta foi vinculada com sucesso! Já pode usar o bot normalmente. 💬");
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL (GPT)
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Analise a mensagem abaixo e classifique-a:
- "entrada" → ganhos, recebimentos, salário, etc.
- "saida" → despesas, compras, gastos, pagamentos, etc.
- "consulta" → perguntas como saldo, quanto gastei, resumo.
- "outros" → se não se encaixar.

Extraia também o valor (número) e uma breve descrição.

Retorne apenas JSON:
{"acao":"entrada|saida|consulta|outros","valor":123.45,"descricao":"texto resumido"}

Mensagem: "${text}"
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
    console.error("⚠️ Erro IA interpretação:", err);
    return { acao: "outros", valor: null, descricao: text };
  }
}

/* ============================================================
💰 REGISTRO DE TRANSAÇÕES (Hub Familiar + Individual)
============================================================ */
async function registrarTransacao({ tipo, valor, descricao, chatId, userId, familyId }) {
  try {
    console.log("🧾 Registrando transação:", { tipo, valor, descricao, chatId, userId, familyId });

    const transacao = {
      tipo,
      valor: Number(valor),
      descricao,
      chat_id: chatId.toString(),
      user_id: userId,
      family_id: familyId || null,
    };

    const { data, error } = await supabase.from("transacoes").insert(transacao).select("*");

    if (error) {
      console.error("❌ Erro ao salvar transação:", error);
      await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
    } else {
      const label = tipo === "entrada" ? "Entrada" : "Saída";
      await sendMessage(chatId, `${label} registrada: R$${valor}`);
      console.log("✅ Transação salva:", data);
    }
  } catch (err) {
    console.error("💥 Erro crítico:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro interno ao registrar transação.");
  }
}

/* ============================================================
📊 CONSULTAS FINANCEIRAS (IA + cálculos diretos)
============================================================ */
async function responderConsulta(chatId, text, familyId, userId) {
  const filtro = familyId ? { family_id: familyId } : { user_id: userId };
  const { data } = await supabase.from("transacoes").select("*").match(filtro);

  const entradas = data?.filter((t) => t.tipo === "entrada").reduce((a, b) => a + Number(b.valor), 0) || 0;
  const saidas = data?.filter((t) => t.tipo === "saida").reduce((a, b) => a + Number(b.valor), 0) || 0;
  const saldo = entradas - saidas;

  if (/saldo|quanto tenho|dinheiro/i.test(text)) {
    await sendMessage(chatId, `💰 Seu saldo atual é *R$${saldo.toFixed(2)}*`);
    return;
  }

  const resumo =
    data?.map(
      (t) =>
        `${t.tipo}: R$${t.valor} - ${t.descricao} (${new Date(
          t.created_at
        ).toLocaleDateString("pt-BR")})`
    ).join("\n") || "Sem transações registradas.";

  const prompt = `
Você é um assistente financeiro.
Histórico do usuário:
${resumo}

Pergunta: "${text}"
Responda em português, de forma breve e consultiva.
  `;

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  await sendMessage(chatId, `🤖 ${result.choices[0].message.content}`);
}

/* ============================================================
📈 PROJEÇÃO FINANCEIRA (IA)
============================================================ */
app.post("/projection", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id é obrigatório" });

    const { data } = await supabase
      .from("transacoes")
      .select("tipo, valor, descricao, created_at")
      .eq("user_id", user_id)
      .order("created_at");

    if (!data?.length) return res.status(404).json({ message: "Sem dados financeiros." });

    const prompt = `
Você é um consultor financeiro.
Analise as transações e crie uma projeção para os próximos 6 meses:
${JSON.stringify(data, null, 2)}

Responda:
1. Um resumo de insights.
2. Um JSON com:
{
  "meses": ["Nov/2025", "Dez/2025", ...],
  "saldo_projetado": [3500, 4200, ...],
  "recomendacoes": ["Reduzir gastos com lazer", ...]
}
`;

    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    res.json({ result: result.choices[0].message.content });
  } catch (err) {
    console.error("❌ Erro projeção:", err);
    res.status(500).json({ error: "Erro ao gerar projeção." });
  }
});

/* ============================================================
🤖 WEBHOOK TELEGRAM — conversa natural e inteligente
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return res.sendStatus(200);

  console.log("💬 Mensagem recebida:", text);

  if (text.toLowerCase().startsWith("/ativar") || text.toLowerCase().startsWith("/vincular")) {
    await comandoAtivar(chatId, text);
    return res.sendStatus(200);
  }

  const userData = await buscarUsuario(chatId);
  if (!userData) {
    await sendMessage(chatId, "🔒 Sua conta ainda não está vinculada. Gere seu token e envie `/ativar TLG-XXXXXX`");
    return res.sendStatus(200);
  }

  const { user_id, family_id } = userData;
  const interpret = await interpretarMensagem(text);
  console.log("🧠 Interpretação:", interpret);

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
  } else if (text === "/projecao") {
    const response = await fetch(`${process.env.RENDER_URL}/projection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    });
    const proj = await response.json();
    await sendMessage(chatId, proj.result || "⚠️ Não consegui gerar projeção agora.");
  } else {
    await sendMessage(chatId, "💬 Não entendi. Pode tentar novamente?");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
