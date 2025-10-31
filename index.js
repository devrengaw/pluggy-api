// index.js — FinanceFlow completo com IA, Categorias, Aprendizado, Hub Familiar, Comandos Inteligentes e Teste de 30 dias (Plano PRO)
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
🆓 TESTE DE 30 DIAS (PLANO PRO)
============================================================ */
app.post("/ativar-teste", async (req, res) => {
  const { user_id } = req.body;
  try {
    // Verifica se já tem teste ativo
    const { data: usuario } = await supabase
      .from("users")
      .select("plano, trial_ativo, trial_expira_em")
      .eq("id", user_id)
      .maybeSingle();

    if (!usuario) return res.status(404).json({ success: false, message: "Usuário não encontrado" });

    if (usuario.trial_ativo && new Date(usuario.trial_expira_em) > new Date()) {
      return res.json({
        success: false,
        message: "Você já possui um teste ativo.",
        expira_em: usuario.trial_expira_em,
      });
    }

    // Ativa o teste de 30 dias
    const { error } = await supabase.from("users").update({
      plano: "pro",
      trial_ativo: true,
      trial_expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).eq("id", user_id);

    if (error) throw error;

    res.json({
      success: true,
      message: "✅ Teste de 30 dias ativado com sucesso!",
      expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    console.error("Erro ao ativar teste:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verifica status do teste
app.get("/verificar-teste/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const { data } = await supabase
      .from("users")
      .select("plano, trial_ativo, trial_expira_em")
      .eq("id", user_id)
      .maybeSingle();

    if (!data) return res.status(404).json({ success: false, message: "Usuário não encontrado" });

    const ativo = data.trial_ativo && new Date(data.trial_expira_em) > new Date();

    res.json({
      success: true,
      plano: ativo ? "pro (teste ativo)" : data.plano,
      trial_ativo: ativo,
      expira_em: data.trial_expira_em,
    });
  } catch (err) {
    console.error("Erro ao verificar teste:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
🤖 WEBHOOK TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const cb = body.callback_query;
    const chatId = cb.message.chat.id;
    const user = await buscarUsuario(chatId);
    const userId = user?.user_id;

    if (cb.data.startsWith("cat_")) {
      const [_, transacaoId, categoria] = cb.data.split("_");
      await definirCategoria(transacaoId, categoria, chatId);
    }

    if (cb.data.startsWith("ess_")) {
      const [_, transacaoId, valor] = cb.data.split("_");
      await definirEssencialidade(transacaoId, valor, chatId, userId);
    }

    await sendCallbackAnswer(cb.id);
    return res.sendStatus(200);
  }

  const msg = body.message;
  if (!msg) return res.sendStatus(200);
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return res.sendStatus(200);

  const user = await buscarUsuario(chatId);
  if (!user) {
    await sendMessage(chatId, "🔒 Conta não vinculada. Use `/ativar TLG-XXXXXX`");
    return res.sendStatus(200);
  }

  const { user_id, family_id, perguntar_essencial } = user;
  const interpret = await interpretarMensagem(text);
  console.log("🧠 Interpretação:", interpret);

  switch (interpret.acao) {
    case "entrada":
    case "saida":
      if (interpret.valor)
        await registrarTransacao({
          tipo: interpret.acao,
          valor: interpret.valor,
          descricao: interpret.descricao,
          chatId,
          userId: user_id,
          familyId: family_id,
          perguntarEssencial: perguntar_essencial,
        });
      else await sendMessage(chatId, "💬 Envie algo como `+2000 salário` ou `-150 mercado`");
      break;
    case "saldo":
      await comandoSaldo(chatId, user_id, family_id);
      break;
    case "resumo":
      await comandoResumo(chatId, user_id);
      break;
    case "menu":
    case "/ajuda":
      await sendMessage(chatId, "💡 Comandos disponíveis:\n/saldo\n/resumo\n/projecao\n/limpar");
      break;
    default:
      await sendMessage(chatId, "💬 Não entendi. Envie algo como `gastei 100 no mercado` ou `/menu`.");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
