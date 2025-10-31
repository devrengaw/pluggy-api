// index.js — FinanceFlow com IA, Aprendizado, Relatórios Inteligentes e Telegram (com compatibilidade Hub Família)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import supabase from "./supabase.js";
import OpenAI from "openai";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_URL = process.env.RENDER_URL;
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
    .select("user_id, family_id, perguntar_essencial, frequencia_relatorio")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data || null;
}

/* ============================================================
🔑 ATIVAÇÃO DO TELEGRAM (/ativar ou /vincular)
============================================================ */
async function comandoAtivar(chatId, text) {
  try {
    const partes = text.trim().split(/\s+/);
    const token = partes[1]?.trim();

    if (!token) {
      await sendMessage(chatId, "🔑 Envie o comando assim: `/ativar TLG-123456` ou `/vincular TLG-123456`");
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

    // ✅ Busca o family_id real do usuário, se vier do Hub Família
    const { data: userInfo } = await supabase
      .from("users")
      .select("family_id")
      .eq("id", reg.user_id)
      .maybeSingle();

    const familyIdValido = userInfo?.family_id || null;

    // Vincula o chat ↔ usuário
    const { error: linkErr } = await supabase.from("telegram_users").upsert(
      {
        chat_id: chatId,
        user_id: reg.user_id,
        family_id: familyIdValido, // ✅ Mantém vínculo familiar se existir
        nome: "Usuário FinanceFlow",
        perguntar_essencial: true,
        frequencia_relatorio: "mensal",
      },
      { onConflict: "chat_id" }
    );

    if (linkErr) {
      console.error("Erro ao vincular:", linkErr);
      await sendMessage(chatId, "⚠️ Falha ao vincular sua conta. Tente novamente mais tarde.");
      return;
    }

    // Desativa o token após o uso
    await supabase.from("telegram_tokens").update({ ativo: false }).eq("token", token);
    await supabase.from("users").update({ telegram_chat_id: chatId }).eq("id", reg.user_id);

    await sendMessage(
      chatId,
      "✅ Sua conta foi vinculada com sucesso!\nAgora você pode registrar transações, consultar saldo e configurar relatórios 📊"
    );

  } catch (err) {
    console.error("💥 Erro em comandoAtivar:", err);
    await sendMessage(chatId, "❌ Ocorreu um erro ao tentar vincular sua conta.");
  }
}

/* ============================================================
🧠 MEMÓRIA DE APRENDIZADO
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
  const aprendizado = await preverEssencialUsuario(userId, descricao);
  let essencial = aprendizado;
  if (essencial === null) essencial = preverEssencialHeuristico(descricao);

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
🧠 Heurística padrão
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
📊 RELATÓRIOS IA
============================================================ */
async function gerarRelatorio(userId) {
  const hoje = new Date();
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);

  const { data } = await supabase
    .from("transacoes")
    .select("tipo, valor, essencial")
    .eq("user_id", userId)
    .gte("created_at", inicioMes.toISOString())
    .lte("created_at", fimMes.toISOString());

  if (!data?.length) return null;

  const entradas = data.filter(t => t.tipo === "entrada").reduce((a, b) => a + b.valor, 0);
  const saidas = data.filter(t => t.tipo === "saida").reduce((a, b) => a + b.valor, 0);
  const essenciais = data.filter(t => t.essencial === true).reduce((a, b) => a + b.valor, 0);
  const naoEssenciais = data.filter(t => t.essencial === false).reduce((a, b) => a + b.valor, 0);
  const percentualEssenciais = saidas ? ((essenciais / saidas) * 100).toFixed(1) : 0;
  const percentualNao = saidas ? ((naoEssenciais / saidas) * 100).toFixed(1) : 0;

  const prompt = `
Usuário teve ${percentualNao}% de gastos não essenciais este mês.
Gere uma dica curta e prática de economia em português, em uma frase objetiva.
  `;
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const dica = result.choices[0].message.content.trim();

  return {
    mes: hoje.toLocaleString("pt-BR", { month: "long", year: "numeric" }),
    entradas,
    saidas,
    essenciais,
    naoEssenciais,
    percentualEssenciais,
    percentualNao,
    dica,
  };
}

/* ============================================================
💬 ENVIO DE RELATÓRIOS PELO TELEGRAM
============================================================ */
async function enviarRelatorioTelegram(userId, chatId) {
  const relatorio = await gerarRelatorio(userId);
  if (!relatorio) {
    await sendMessage(chatId, "📭 Nenhuma transação registrada neste período.");
    return;
  }

  const texto = `
📊 *Relatório FinanceFlow — ${relatorio.mes}*

💰 Entradas: R$ ${relatorio.entradas.toFixed(2)}
💸 Saídas: R$ ${relatorio.saidas.toFixed(2)}
🟢 Essenciais: ${relatorio.percentualEssenciais}%
🔴 Não essenciais: ${relatorio.percentualNao}%

💡 Dica da IA:
${relatorio.dica}
  `;
  await sendMessage(chatId, texto);
}

/* ============================================================
🤖 WEBHOOK TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;

  // CALLBACKS
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

    if (data.startsWith("freq_")) {
      const [_, uid, freq] = data.split("_");
      await salvarFrequencia(uid, freq);
      await sendMessage(chatId, `📅 Relatórios configurados como *${freq}*.`);
      await sendCallbackAnswer(callback.id, "Configuração salva!");
    }

    return res.sendStatus(200);
  }

  // MENSAGENS
  const msg = body.message;
  if (!msg) return res.sendStatus(200);
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return res.sendStatus(200);

  // ✅ Comando de ativação
  if (text.toLowerCase().startsWith("/ativar") || text.toLowerCase().startsWith("/vincular")) {
    await comandoAtivar(chatId, text);
    return res.sendStatus(200);
  }

  const userData = await buscarUsuario(chatId);
  if (!userData) {
    await sendMessage(chatId, "🔒 Sua conta não está vinculada. Use `/ativar TLG-XXXXXX`");
    return res.sendStatus(200);
  }

  const { user_id, family_id, perguntar_essencial } = userData;

  if (text === "/resumo") {
    await enviarRelatorioTelegram(user_id, chatId);
    return res.sendStatus(200);
  }

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
    await sendMessage(chatId, "💬 Comandos úteis:\n`+2500 salário`\n`-300 mercado`\n`/resumo`\n`/frequencia`");
  }

  res.sendStatus(200);
});

/* ============================================================
⏰ CRONS AUTOMÁTICOS
============================================================ */
cron.schedule("0 9 * * 1", async () => {
  const { data } = await supabase.from("telegram_users").select("chat_id, user_id, frequencia_relatorio");
  for (const u of data || []) {
    if (["semanal", "todos"].includes(u.frequencia_relatorio))
      await enviarRelatorioTelegram(u.user_id, u.chat_id);
  }
});

cron.schedule("0 9 1,15 * *", async () => {
  const { data } = await supabase.from("telegram_users").select("chat_id, user_id, frequencia_relatorio");
  for (const u of data || []) {
    if (["quinzenal", "todos"].includes(u.frequencia_relatorio))
      await enviarRelatorioTelegram(u.user_id, u.chat_id);
  }
});

cron.schedule("0 9 1 * *", async () => {
  const { data } = await supabase.from("telegram_users").select("chat_id, user_id, frequencia_relatorio");
  for (const u of data || []) {
    if (["mensal", "todos"].includes(u.frequencia_relatorio))
      await enviarRelatorioTelegram(u.user_id, u.chat_id);
  }
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
