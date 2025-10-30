// index.js — FinanceFlow com IA, Categorias, Aprendizado Adaptativo e Regras de Essencialidade Inteligente
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
🧠 INTERPRETAÇÃO NATURAL (GPT)
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Você é um analisador de mensagens financeiras.
Identifique se o texto representa uma "entrada", "saida", "consulta", "menu" ou "outros".
Extraia o valor numérico e uma breve descrição.

Retorne APENAS JSON, neste formato:
{
  "acao": "entrada" | "saida" | "consulta" | "menu" | "outros",
  "valor": número ou null,
  "descricao": "texto curto"
}

Texto: "${text}"
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
    console.error("⚠️ Erro IA:", err);
    return { acao: "outros", valor: null, descricao: text };
  }
}

/* ============================================================
🧠 APRENDIZADO — MEMÓRIA DE ESSENCIALIDADE
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
    .slice(0, 5);
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
    if (data) return data.essencial;
  }
  return null;
}

/* ============================================================
💡 Função para detectar se é fixa ou variável
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
💰 REGISTRO DE TRANSAÇÃO
============================================================ */
async function registrarTransacao({
  tipo,
  valor,
  descricao,
  chatId,
  userId,
  familyId,
  perguntarEssencial,
}) {
  const tipo_fixo = detectarTipoFixo(descricao);
  const aprendizado = await preverEssencialUsuario(userId, descricao);
  let essencial = aprendizado;
  if (essencial === null) essencial = null;

  const { data, error } = await supabase
    .from("transacoes")
    .insert({
      tipo,
      valor: Number(valor),
      descricao,
      tipo_fixo,
      essencial,
      categoria: null,
      user_id: userId,
      family_id: familyId || null,
      chat_id: chatId.toString(),
    })
    .select("id, essencial, categoria, tipo")
    .maybeSingle();

  if (error) {
    console.error("Erro ao registrar:", error);
    await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
    return;
  }

  const label = tipo === "entrada" ? "Entrada registrada: 💰" : "Saída registrada: 💸";
  await sendMessage(chatId, `${label} R$${valor} (${descricao})`);

  // Perguntar categoria
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

  // Perguntar essencialidade SOMENTE se for saída
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

  if (!error) {
    await sendMessage(chatId, essencial ? "🟢 Marcado como *essencial*" : "🔴 Marcado como *não essencial*");
    await atualizarMemoriaEssencial(userId, data.descricao, essencial);
  }
}

async function definirCategoria(transactionId, categoria, chatId) {
  const { error } = await supabase.from("transacoes").update({ categoria }).eq("id", transactionId);
  if (error) {
    await sendMessage(chatId, "⚠️ Erro ao salvar categoria.");
  } else {
    await sendMessage(chatId, `🗂 Categoria registrada como *${categoria}*`);
  }
}

/* ============================================================
📋 MENU / AJUDA
============================================================ */
async function comandoMenu(chatId) {
  await sendMessage(
    chatId,
    `
👋 *Bem-vindo ao FinanceFlow!*
Você pode falar comigo naturalmente 🧠

Exemplos:
- "recebi 2000 salário"
- "gastei 150 mercado"
- "quanto tenho?"
- "/ajuda" → Mostra este menu
`
  );
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

    if (data.startsWith("cat_")) {
      const [_, transacaoId, categoria] = data.split("_");
      await definirCategoria(transacaoId, categoria, chatId);
      await sendCallbackAnswer(callback.id, "Categoria definida!");
    }

    return res.sendStatus(200);
  }

  // === MENSAGENS ===
  const msg = body.message;
  if (!msg) return res.sendStatus(200);
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return res.sendStatus(200);

  // === MENU ===
  if (["/menu", "/ajuda", "ajuda", "menu"].includes(text.toLowerCase())) {
    await comandoMenu(chatId);
    return res.sendStatus(200);
  }

  // === BUSCAR USUÁRIO ===
  const userData = await buscarUsuario(chatId);
  if (!userData) {
    await sendMessage(chatId, "🔒 Conta não vinculada. Use `/ativar TLG-XXXXXX`");
    return res.sendStatus(200);
  }
  const { user_id, family_id, perguntar_essencial } = userData;

  // === INTERPRETAÇÃO IA ===
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
      perguntarEssencial: perguntar_essencial,
    });
  } else {
    await sendMessage(chatId, "💬 Envie algo como `+2500 salário` ou `-300 mercado`");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
