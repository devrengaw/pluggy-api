// index.js (backend Render)
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
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function garantirUsuario(chatId) {
  const { data: vinculo } = await supabase
    .from("telegram_users")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();

  return vinculo?.user_id || null;
}

/* ============================================================
 🔑 VINCULAR CONTA (token gerado no site)
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
    .select("user_id, ativo")
    .eq("token", token)
    .maybeSingle();

  if (error || !reg) {
    await sendMessage(chatId, "❌ Código inválido.");
    return;
  }
  if (!reg.ativo) {
    await sendMessage(chatId, "⚠️ Este código já foi utilizado ou está desativado.");
    return;
  }

  await supabase.from("telegram_users").upsert(
    {
      chat_id: chatId,
      user_id: reg.user_id,
      nome: "Usuário FinanceFlow",
    },
    { onConflict: "chat_id" }
  );

  await supabase.from("telegram_tokens").update({ ativo: false }).eq("token", token);
  await supabase.from("users").update({ telegram_chat_id: chatId }).eq("id", reg.user_id);

  await sendMessage(chatId, "✅ Sua conta foi *vinculada com sucesso!* Agora você já pode usar todos os comandos do bot.");
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
  });

  if (error) {
    console.error("❌ Erro ao salvar entrada:", error);
    await sendMessage(chatId, "⚠️ Erro ao salvar a entrada.");
  } else {
    await sendMessage(chatId, `✅ *Entrada registrada:*\nR$${valor} — ${descricao}`);
  }
}

async function comandoSaida(chatId, text, userId) {
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
    user_id: userId,
  });

  if (error) {
    console.error("❌ Erro ao salvar saída:", error);
    await sendMessage(chatId, "⚠️ Erro ao salvar a saída.");
  } else {
    const extra = metodo === "credito" ? `💳 (${metodo.toUpperCase()} - ${cartao})` : `💸 (${metodo})`;
    await sendMessage(chatId, `💸 *Saída registrada:*\nR$${valor} ${extra}\n${descricao}`);
  }
}

async function comandoSaldo(chatId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .eq("chat_id", chatId);
  if (error || !data) return sendMessage(chatId, "⚠️ Erro ao buscar saldo.");

  const saldo = data.reduce(
    (acc, item) => acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor)),
    0
  );
  await sendMessage(chatId, `📊 *Seu saldo atual é:*\nR$${saldo.toFixed(2)}`);
}

/* ============================================================
 🧠 IA com memória
============================================================ */
async function comandoInteligente(chatId, text) {
  const pergunta = text.trim();
  if (!pergunta) {
    await sendMessage(chatId, "💬 Pode me perguntar algo, por exemplo:\n'Quanto gastei este mês?'");
    return;
  }

  const { data: historico } = await supabase
    .from("conversas")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(10);

  const contexto = historico?.map((m) => ({ role: m.role, content: m.content })) || [];
  contexto.push({ role: "user", content: pergunta });

  const { data: transacoes } = await supabase
    .from("transacoes")
    .select("tipo, valor, descricao, metodo, created_at")
    .eq("chat_id", chatId);

  const resumo =
    transacoes?.map(
      (t) =>
        `${t.tipo}: R$${t.valor} - ${t.descricao} (${t.metodo || "n/a"}) em ${new Date(
          t.created_at
        ).toLocaleDateString("pt-BR")}`
    ).join("\n") || "Nenhuma transação registrada.";

  const systemPrompt = `
Você é um assistente financeiro pessoal.
Fale de forma natural, amigável e encorajadora.
Analise as transações abaixo e ajude o usuário a entender seus hábitos financeiros.
Transações:
${resumo}
`;

  try {
    const resposta = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...contexto],
      temperature: 0.3,
    });

    const conteudo = resposta.choices[0].message.content;

    await supabase.from("conversas").insert([
      { chat_id: chatId, role: "user", content: pergunta },
      { chat_id: chatId, role: "assistant", content: conteudo },
    ]);

    await sendMessage(chatId, `🤖 ${conteudo}`);
  } catch (err) {
    console.error("Erro IA:", err);
    await sendMessage(chatId, "⚠️ Erro ao processar sua pergunta com IA.");
  }
}

/* ============================================================
 🤖 Webhook Telegram
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.trim() || "";

  try {
    const isStartOrVincular = text.toLowerCase().startsWith("/start") || text.toLowerCase().startsWith("/vincular");
    let userId = null;

    if (!isStartOrVincular) {
      userId = await garantirUsuario(chatId);
      if (!userId) {
        await sendMessage(
          chatId,
          "⚠️ Sua conta ainda não está vinculada. Gere seu token no site e envie `/vincular <token>`."
        );
        return res.sendStatus(200);
      }
    }

    if (text.toLowerCase() === "/start") {
      await sendMessage(
        chatId,
        "👋 Oi! Eu sou o assistente financeiro do *FinanceFlow*.\n\n" +
          "Para começar, gere seu token no site e envie aqui:\n" +
          "`/vincular TG-123456`"
      );
    } else if (text.startsWith("/vincular")) await comandoVincular(chatId, text);
    else if (text.startsWith("/entrada")) await comandoEntrada(chatId, text, userId);
    else if (text.startsWith("/saida")) await comandoSaida(chatId, text, userId);
    else if (text === "/saldo") await comandoSaldo(chatId);
    else if (text === "/limpar") {
      await supabase.from("conversas").delete().eq("chat_id", chatId);
      await sendMessage(chatId, "🧹 Memória do chat limpa com sucesso!");
    } else {
      await comandoInteligente(chatId, text);
    }
  } catch (err) {
    console.error("Erro no webhook:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro inesperado.");
  }

  res.sendStatus(200);
});

/* ============================================================
 🌐 Server
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
