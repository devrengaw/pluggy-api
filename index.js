// index.js — FinanceFlow completo com IA, Categorias, Aprendizado, Hub Familiar, Comandos Inteligentes, Vincular Telegram, Boas-Vindas e compatibilidade total com Telegram Webhook
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

    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.log("⚠️ Falha ao enviar mensagem:", await r.text());
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
  }
}

async function sendCallbackAnswer(callbackQueryId, text = "OK") {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    console.error("Erro ao responder callback:", err);
  }
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
🧠 MEMÓRIA DE ESSENCIALIDADE
============================================================ */
function extrairPalavrasChave(texto) {
  return texto.toLowerCase().split(/[\s,.;:!?()]+/).filter(p => p.length > 3 && isNaN(p)).slice(0, 5);
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
  if (fixas.some(p => lower.includes(p))) return "fixa";
  if (variaveis.some(p => lower.includes(p))) return "variavel";
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
    console.error("❌ Erro ao registrar:", error);
    return await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
  }

  const label = tipo === "entrada" ? "💰 Entrada registrada" : "💸 Saída registrada";
  await sendMessage(chatId, `${label}: R$${valor} — ${descricao}`);

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
🤖 WEBHOOK TELEGRAM (com boas-vindas FinanceFlow)
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  // ... (sua lógica completa atual)
});

/* ============================================================
🏓 ROTAS DE COMPATIBILIDADE TELEGRAM (GET/POST universais)
============================================================ */
app.get(/^\/webhook\/.*/, (req, res) => {
  console.log("📡 GET recebido do Telegram (validação de webhook)");
  res.status(200).send("✅ Webhook FinanceFlow ativo (GET detectado).");
});

app.post(/^\/webhook\/.*/, (req, res) => {
  console.log("📩 POST recebido do Telegram (fallback universal)");
  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
