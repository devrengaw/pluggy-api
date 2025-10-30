// index.js
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


// ============================================================
// 🔐 GARANTIR USUÁRIO (VÍNCULO TELEGRAM ↔ SUPABASE USER)
// ============================================================
async function garantirUsuario(chatId) {
  const { data: vinculo } = await supabase
    .from("telegram_users")
    .select("user_id")
    .eq("chat_id", chatId)
    .single();

  if (!vinculo) {
    console.log("⚠️ Nenhum vínculo encontrado para chat_id:", chatId);
    return null;
  }

  return vinculo.user_id;
}


// ============================================================
// 🔧 FUNÇÕES UTILITÁRIAS
// ============================================================
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function calcularSaldo(userId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .eq("user_id", userId);
  if (error || !data) return null;
  const saldo = data.reduce(
    (acc, item) =>
      acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor)),
    0
  );
  return saldo.toFixed(2);
}


// ============================================================
// 💰 COMANDOS FINANCEIROS
// ============================================================
async function comandoEntrada(chatId, text) {
  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(chatId, "⚠️ Sua conta ainda não está vinculada. Gere seu token no site e envie /vincular <seu_token>.");
    return;
  }

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

async function comandoSaida(chatId, text) {
  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(chatId, "⚠️ Sua conta ainda não está vinculada. Gere seu token no site e envie /vincular <seu_token>.");
    return;
  }

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
    const extra =
      metodo === "credito"
        ? `💳 (${metodo.toUpperCase()} - ${cartao})`
        : `💸 (${metodo})`;
    await sendMessage(chatId, `💸 *Saída registrada:*\nR$${valor} ${extra}\n${descricao}`);
  }
}

async function comandoSaldo(chatId) {
  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(chatId, "⚠️ Você ainda não vinculou sua conta. Gere o token no site e use /vincular <token>.");
    return;
  }

  const saldo = await calcularSaldo(userId);
  if (saldo === null) await sendMessage(chatId, "⚠️ Erro ao buscar saldo.");
  else await sendMessage(chatId, `📊 *Seu saldo atual é:*\nR$${saldo}`);
}

async function comandoResumo(chatId) {
  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(chatId, "⚠️ Sua conta ainda não está vinculada. Gere seu token no site e envie /vincular <token>.");
    return;
  }

  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor, created_at")
    .eq("user_id", userId)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  if (error || !data || data.length === 0) {
    await sendMessage(chatId, "📭 Nenhuma transação nos últimos 7 dias.");
    return;
  }

  const totalEntrada = data.filter(t => t.tipo === "entrada").reduce((acc, t) => acc + Number(t.valor), 0);
  const totalSaida = data.filter(t => t.tipo === "saida").reduce((acc, t) => acc + Number(t.valor), 0);
  const saldo = totalEntrada - totalSaida;

  await sendMessage(
    chatId,
    `📅 *Resumo dos últimos 7 dias:*\n\n💰 Entradas: R$${totalEntrada.toFixed(2)}\n💸 Saídas: R$${totalSaida.toFixed(2)}\n📊 Saldo: R$${saldo.toFixed(2)}`
  );
}


// ============================================================
// 🧠 COMANDO INTELIGENTE COM MEMÓRIA
// ============================================================
async function comandoInteligente(chatId, text) {
  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(chatId, "⚠️ Sua conta ainda não está vinculada. Gere seu token no site e envie /vincular <token>.");
    return;
  }

  const pergunta = text.trim();
  if (!pergunta) {
    await sendMessage(chatId, "💬 Pode me perguntar algo, por exemplo:\n'Quanto gastei este mês?'");
    return;
  }

  const { data: historico } = await supabase
    .from("conversas")
    .select("role, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(10);

  const contexto = historico?.map((m) => ({ role: m.role, content: m.content })) || [];
  contexto.push({ role: "user", content: pergunta });

  const { data: transacoes } = await supabase
    .from("transacoes")
    .select("tipo, valor, descricao, metodo, created_at")
    .eq("user_id", userId);

  const resumo =
    transacoes?.map(
      (t) => `${t.tipo}: R$${t.valor} - ${t.descricao} (${t.metodo || "n/a"}) em ${new Date(t.created_at).toLocaleDateString("pt-BR")}`
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
      { user_id: userId, role: "user", content: pergunta },
      { user_id: userId, role: "assistant", content: conteudo },
    ]);

    await sendMessage(chatId, `🤖 ${conteudo}`);
  } catch (err) {
    console.error("Erro IA:", err);
    await sendMessage(chatId, "⚠️ Erro ao processar sua pergunta com IA.");
  }
}


// ============================================================
// 🔗 COMANDO DE VINCULAÇÃO /vincular TOKEN
// ============================================================
async function comandoVincular(chatId, text) {
  const token = text.split(" ")[1];
  if (!token) {
    await sendMessage(chatId, "⚠️ Envie o comando no formato: /vincular TLG-XXXXXX");
    return;
  }

  const { data: vinculo, error } = await supabase
    .from("telegram_users")
    .select("user_id, valid_until")
    .eq("token", token)
    .single();

  if (error || !vinculo) {
    await sendMessage(chatId, "❌ Token inválido ou não encontrado.");
    return;
  }

  const expirou = new Date(vinculo.valid_until) < new Date();
  if (expirou) {
    await sendMessage(chatId, "⏰ Seu token expirou. Gere um novo no site do FinanceFlow.");
    return;
  }

  await supabase
    .from("telegram_users")
    .update({ chat_id: chatId, token: null })
    .eq("user_id", vinculo.user_id);

  await supabase
    .from("users")
    .update({ telegram_chat_id: chatId })
    .eq("id", vinculo.user_id);

  await sendMessage(chatId, "✅ Conta vinculada com sucesso! Agora você pode conversar comigo sobre suas finanças 💬");
}


// ============================================================
// 🧹 LIMPAR MEMÓRIA
// ============================================================
async function comandoLimpar(chatId) {
  const userId = await garantirUsuario(chatId);
  if (!userId) {
    await sendMessage(chatId, "⚠️ Você ainda não vinculou sua conta.");
    return;
  }
  await supabase.from("conversas").delete().eq("user_id", userId);
  await sendMessage(chatId, "🧹 Memória do chat limpa com sucesso!");
}


// ============================================================
// 🤖 ROTEAMENTO DO TELEGRAM (CONVERSACIONAL)
// ============================================================
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";

  try {
    if (text.toLowerCase() === "/start") {
      await sendMessage(
        chatId,
        "👋 Oi! Que bom te ver por aqui.\n\nSou seu *assistente financeiro pessoal* — posso te ajudar a entender, organizar e acompanhar suas finanças.\n\nAntes de começarmos, gere seu token no site do *FinanceFlow* e envie aqui:\n\n`/vincular TLG-XXXXXX`\n\nAssim conecto sua conta com segurança 💙"
      );
    } else if (text.startsWith("/vincular")) await comandoVincular(chatId, text);
    else if (text.startsWith("/entrada")) await comandoEntrada(chatId, text);
    else if (text.startsWith("/saida")) await comandoSaida(chatId, text);
    else if (text === "/saldo") await comandoSaldo(chatId);
    else if (text === "/resumo") await comandoResumo(chatId);
    else if (text === "/limpar") await comandoLimpar(chatId);
    else await comandoInteligente(chatId, text);
  } catch (err) {
    console.error("Erro no webhook:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro inesperado.");
  }

  res.sendStatus(200);
});


// ============================================================
// 🌐 SERVER
// ============================================================
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
