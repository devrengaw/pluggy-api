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

async function comandoSaldo(chatId, userId, familyId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .or(`user_id.eq.${userId},family_id.eq.${familyId}`);
  if (error) {
    console.error(error);
    return await sendMessage(chatId, "⚠️ Erro ao calcular saldo.");
  }
  if (!data?.length) return await sendMessage(chatId, "📭 Nenhuma transação encontrada.");
  const total = data.reduce((acc, t) => acc + (t.tipo === "entrada" ? t.valor : -t.valor), 0);
  await sendMessage(chatId, `📊 *Seu saldo atual é:* R$${total.toFixed(2)}`);
}

async function comandoResumo(chatId, userId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor, descricao, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.error(error);
    return await sendMessage(chatId, "⚠️ Erro ao gerar resumo.");
  }
  if (!data?.length) return await sendMessage(chatId, "📭 Nenhuma transação recente.");
  const linhas = data
    .map(
      (t) =>
        `${t.tipo === "entrada" ? "💰" : "💸"} ${t.descricao} — R$${t.valor} em ${new Date(
          t.created_at
        ).toLocaleDateString("pt-BR")}`
    )
    .join("\n");
  await sendMessage(chatId, `🧾 *Últimas transações:*\n${linhas}`);
}

/* ============================================================
🔄 CALLBACKS (helpers)
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
  if (data?.descricao) await atualizarMemoriaEssencial(userId, data.descricao, essencial);
}

/* ============================================================
🔑 GERAR TOKEN TELEGRAM
============================================================ */
app.post("/gerar-token-telegram", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: "Usuário não informado" });

    // Busca family_id do usuário
    const { data: user } = await supabase
      .from("users")
      .select("id, family_id")
      .eq("id", user_id)
      .maybeSingle();
    if (!user) return res.status(404).json({ success: false, message: "Usuário não encontrado" });

    // Desativa tokens anteriores
    await supabase.from("telegram_tokens").update({ ativo: false }).eq("user_id", user_id);

    // Gera token novo
    const token = "TLG-" + randomUUID().split("-")[0].toUpperCase();
    const { error } = await supabase.from("telegram_tokens").insert({
      token,
      user_id,
      family_id: user.family_id || null,
      ativo: true,
      criado_em: new Date(),
    });
    if (error) throw error;

    return res.json({ success: true, token, message: "Novo token Telegram gerado com sucesso." });
  } catch (err) {
    console.error("❌ Erro ao gerar token Telegram:", err);
    return res.status(500).json({ success: false, message: "Erro ao gerar token.", error: err.message });
  }
});

/* ============================================================
🆓 TESTE DE 30 DIAS
============================================================ */
app.post("/ativar-teste", async (req, res) => {
  const { user_id } = req.body;
  try {
    const { data: usuario, error } = await supabase
      .from("users")
      .select("plano, trial_ativo, trial_expira_em")
      .eq("id", user_id)
      .maybeSingle();

    if (error || !usuario)
      return res.status(404).json({ success: false, message: "Usuário não encontrado" });

    if (usuario.trial_ativo && new Date(usuario.trial_expira_em) > new Date()) {
      return res.json({
        success: false,
        message: "Você já possui um teste ativo.",
        expira_em: usuario.trial_expira_em,
      });
    }

    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await supabase
      .from("users")
      .update({
        plano: "pro",
        trial_ativo: true,
        trial_expira_em: expiraEm,
      })
      .eq("id", user_id);

    res.json({
      success: true,
      message: "✅ Teste de 30 dias ativado com sucesso!",
      expira_em: expiraEm,
    });
  } catch (err) {
    console.error("Erro ao ativar teste:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
/* ============================================================
🤖 WEBHOOK TELEGRAM (com /start, /menu, /help e leitura de foto)
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;
  const msg = body.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  
/* ============================================================
📸 DETECTA ENVIO DE FOTO (nota fiscal ou recibo)
============================================================ */
  
if (msg.photo && msg.photo.length > 0) {
  try {
    // 🧩 Importa Tesseract dinamicamente (compatível com ESM + Render)
    const pkgTesseract = await import("tesseract.js");
    const { createWorker } = pkgTesseract;

    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const tgResp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileInfo = await tgResp.json();

    if (!fileInfo?.ok) {
      await sendMessage(chatId, "⚠️ Erro ao baixar imagem. Tente novamente.");
      return res.sendStatus(200);
    }

    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    await sendMessage(chatId, "🧾 Recebido! Estou lendo sua nota fiscal...");

    // 🔠 OCR: extrai texto da imagem
    const worker = await createWorker("por"); // idioma português
    const { data: ocrResult } = await worker.recognize(fileUrl);
    await worker.terminate();

    const textoExtraido = ocrResult.text;
    console.log("🧠 Texto OCR extraído:", textoExtraido.slice(0, 300));

    // 🧠 Envia texto para IA interpretar
    const prompt = `
Você é um assistente financeiro.
Analise o texto de uma nota fiscal abaixo e extraia:
- O valor total da compra (ex: 153.29)
- O nome do estabelecimento (se disponível)

Responda APENAS em JSON:
{
  "valor": número,
  "descricao": "texto breve"
}

Texto da nota:
"""
${textoExtraido}
"""
`;

    const aiResult = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = aiResult.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const dataExtraida = match ? JSON.parse(match[0]) : null;

    if (!dataExtraida?.valor) {
      await sendMessage(chatId, "⚠️ Não consegui identificar o valor total. Envie uma imagem mais nítida.");
      return res.sendStatus(200);
    }

   // 💬 Confirmação antes de registrar (com opção de correção)
const descricaoSafe = encodeURIComponent(dataExtraida.descricao || "Compra");

const replyMarkup = {
  inline_keyboard: [
    [
      { text: "✅ Confirmar", callback_data: `conf_foto_${dataExtraida.valor}_${descricaoSafe}` },
      { text: "✏️ Corrigir valor", callback_data: `corrigir_${descricaoSafe}` },
      { text: "❌ Cancelar", callback_data: "cancelar_foto" },
    ],
  ],
};

await sendMessage(
  chatId,
  `Detectei *R$${dataExtraida.valor}* em *${dataExtraida.descricao}*.\nDeseja registrar essa compra como saída?`,
  replyMarkup
);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro OCR+IA:", err);
    await sendMessage(chatId, "⚠️ Ocorreu um erro ao analisar a nota. Tente novamente.");
    return res.sendStatus(200);
  }
}
  
/* ============================================================
🎛 CALLBACKS (categorias, essencial, confirmações e corrigir)
============================================================ */
if (body.callback_query) {
  const cb = body.callback_query;
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const user = await buscarUsuario(chatId);
  const userId = user?.user_id;

  console.log("🧩 Callback recebido:", data);

  try {
    // ✅ CONFIRMAR FOTO
    if (data.startsWith("conf_foto_")) {
      const [_, valor, ...descParts] = data.split("_");
      const descricao = decodeURIComponent(descParts.join("_"));
      if (!user) {
        await sendMessage(chatId, "🔒 Conta não vinculada. Use `/vincular TLG-XXXXXX`.");
        await sendCallbackAnswer(cb.id);
        return res.sendStatus(200);
      }

      await registrarTransacao({
        tipo: "saida",
        valor,
        descricao,
        chatId,
        userId: user.user_id,
        familyId: user.family_id,
        perguntarEssencial: user.perguntar_essencial,
      });

      await sendMessage(chatId, "💸 Saída registrada com sucesso!");
      await sendCallbackAnswer(cb.id);
      return res.sendStatus(200);
    }

    // ✏️ CORRIGIR VALOR
    if (data.startsWith("corrigir_")) {
      const descricao = decodeURIComponent(data.replace("corrigir_", ""));
      await sendMessage(
        chatId,
        `✏️ Digite o valor correto para *${descricao}* (ex: 152.35):`
      );

      await supabase.from("telegram_temp").upsert({
        chat_id: chatId.toString(),
        contexto: "corrigir_valor",
        descricao,
        atualizado_em: new Date(),
      });

      await sendCallbackAnswer(cb.id);
      return res.sendStatus(200);
    }

    // ❌ CANCELAR
    if (data === "cancelar_foto") {
      await sendMessage(chatId, "❌ Registro cancelado.");
      await sendCallbackAnswer(cb.id);
      return res.sendStatus(200);
    }

    // 🗂 CATEGORIA
    if (data.startsWith("cat_")) {
      const [_, transacaoId, categoria] = data.split("_");
      await definirCategoria(transacaoId, categoria, chatId);
      await sendCallbackAnswer(cb.id);
      return res.sendStatus(200);
    }

    // ⚙️ ESSENCIALIDADE
    if (data.startsWith("ess_")) {
      const [_, transacaoId, valor] = data.split("_");
      await definirEssencialidade(transacaoId, valor, chatId, userId);
      await sendCallbackAnswer(cb.id);
      return res.sendStatus(200);
    }
    
// 📋 CALLBACKS DO MENU DE AJUDA
if (["ajuda_entrada", "ajuda_saida", "ajuda_resumo", "ajuda_ia", "ajuda_vinculo"].includes(data)) {
  switch (data) {
    case "ajuda_entrada":
      await sendMessage(chatId, "💰 Envie algo como `+2000 salário` para registrar uma *entrada*.");
      break;
    case "ajuda_saida":
      await sendMessage(chatId, "💸 Envie algo como `-150 mercado` para registrar uma *saída*.");
      break;
    case "ajuda_resumo":
      await sendMessage(chatId, "📊 Veja seu resumo completo no app FinanceFlow, na aba *Dashboard*.");
      break;
    case "ajuda_ia":
      await sendMessage(chatId, "🧠 A IA classifica automaticamente suas transações e aprende seus hábitos financeiros.");
      break;
    case "ajuda_vinculo":
      await sendMessage(
        chatId,
        "🔗 Para vincular sua conta:\n" +
          "1️⃣ Gere um novo token no app (Configurações → Integrações → Telegram)\n" +
          "2️⃣ Envie aqui `/vincular TLG-XXXXXX`"
      );
      break;
  }

  await sendCallbackAnswer(cb.id);
  return res.sendStatus(200);
}
    // 🔚 Fallback: marca callback como respondido
    await sendCallbackAnswer(cb.id);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro ao processar callback:", err);
    try {
      await sendCallbackAnswer(cb.id, "Erro ao processar ação");
    } catch {}
    return res.sendStatus(200);
  }
}
  
  /* ============================================================
  💬 COMANDOS DE TEXTO (/start, /menu, /help)
  ============================================================ */
  if (text?.toLowerCase() === "/start") {
  await sendMessage(
    chatId,
    "👋 *Bem-vindo(a) ao FinanceFlow!*\n\n" +
      "💡 Aqui você pode registrar seus *ganhos* e *gastos* diretamente pelo Telegram, e tudo será sincronizado automaticamente com o app.\n\n" +
      "🪄 *Antes de começar*, é preciso vincular sua conta:\n" +
      "1️⃣ No app FinanceFlow, vá em *Configurações → Integrações → Telegram*.\n" +
      "2️⃣ Toque em *Gerar novo token*.\n" +
      "3️⃣ Copie o código gerado (ex: `TLG-AB12CD`).\n" +
      "4️⃣ Volte aqui e envie:\n`/vincular TLG-AB12CD`\n\n" +
      "✨ Depois disso, você já pode enviar mensagens como:\n" +
      "`+2500 salário`\n" +
      "`-150 mercado`\n\n" +
      "Use /menu para ver as funções disponíveis ou /help para ajuda detalhada."
  );
  return res.sendStatus(200);
}

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

  if (text?.toLowerCase() === "/help") {
    await sendMessage(
      chatId,
      "*📖 Guia FinanceFlow — Ajuda Rápida*\n\n" +
        "💰 Registrar transações: `+2500 salário` ou `-150 mercado`\n" +
        "🧠 IA classifica automaticamente suas transações.\n" +
        "👨‍👩‍👧 Hub Familiar: compartilhe o dashboard com sua família.\n" +
        "🔗 /menu — ver comandos\n/start — boas-vindas\n/help — este guia."
    );
    return res.sendStatus(200);
  }
  
  /* ============================================================
🔑 VINCULAÇÃO VIA TOKEN TELEGRAM
============================================================ */
if (text.toLowerCase().startsWith("/vincular")) {
  const parts = text.split(" ");
  const token = parts[1]?.trim();

  if (!token || !token.startsWith("TLG-")) {
    await sendMessage(chatId, "❌ Formato inválido. Envie assim:\n`/vincular TLG-XXXXXX`");
    return res.sendStatus(200);
  }

  // 🔍 Busca token ativo
  const { data: tokenData, error: tokenError } = await supabase
    .from("telegram_tokens")
    .select("id, user_id, family_id, ativo")
    .eq("token", token)
    .maybeSingle();

  if (tokenError || !tokenData || !tokenData.ativo) {
    await sendMessage(chatId, "⚠️ Token inválido ou expirado. Gere um novo no app FinanceFlow.");
    return res.sendStatus(200);
  }

  // ✅ Vincula conta
  const { error: upsertError } = await supabase.from("telegram_users").upsert({
    chat_id: chatId.toString(),
    user_id: tokenData.user_id,
    family_id: tokenData.family_id,
    perguntar_essencial: true,
    conectado: true,
    atualizado_em: new Date(),
  });

  if (upsertError) {
    console.error("❌ Erro ao vincular Telegram:", upsertError);
    await sendMessage(chatId, "⚠️ Erro ao vincular conta. Tente novamente.");
    return res.sendStatus(200);
  }

  // 🔒 Desativa token após uso
  await supabase
    .from("telegram_tokens")
    .update({ ativo: false, usado_em: new Date() })
    .eq("id", tokenData.id);

  // 🧠 Mensagem final
  await sendMessage(
    chatId,
    "✅ *Conta vinculada com sucesso!*\n\n" +
      "Agora você pode registrar suas transações diretamente por aqui:\n" +
      "Exemplos:\n" +
      "`+2000 salário`\n" +
      "`-150 mercado`\n\n" +
      "Use /menu para ver outras opções."
  );

  return res.sendStatus(200);
}

// 🧩 Verifica se o usuário está corrigindo um valor
const { data: temp } = await supabase
  .from("telegram_temp")
  .select("*")
  .eq("chat_id", chatId)
  .maybeSingle();

if (temp && temp.contexto === "corrigir_valor") {
  const novoValor = parseFloat(text.replace(",", "."));
  if (isNaN(novoValor)) {
    await sendMessage(chatId, "⚠️ Valor inválido. Tente novamente (ex: 153.29).");
    return res.sendStatus(200);
  }

  await registrarTransacao({
    tipo: "saida",
    valor: novoValor,
    descricao: temp.descricao,
    chatId,
    userId: user.user_id,
    familyId: user.family_id,
    perguntarEssencial: user.perguntar_essencial,
  });

  await supabase.from("telegram_temp").delete().eq("chat_id", chatId);
  await sendMessage(chatId, "💸 Saída registrada com o valor corrigido!");
  return res.sendStatus(200);
}
  /* ============================================================
  🧩 REGISTRO DE TEXTO (IA e transações)
  ============================================================ */
  const user = await buscarUsuario(chatId);
  if (!user) {
    await sendMessage(chatId, "🔒 Conta não vinculada. Use `/vincular TLG-XXXXXX`");
    return res.sendStatus(200);
  }

  const { user_id, family_id, perguntar_essencial } = user;
  const interpret = await interpretarMensagem(text);

  switch (interpret.acao) {
    case "entrada":
    case "saida":
      if (interpret.valor) {
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
        await sendMessage(chatId, "💬 Envie algo como `+2000 salário` ou `-150 mercado`");
      }
      break;
    case "saldo":
      await comandoSaldo(chatId, user_id, family_id);
      break;
    case "resumo":
      await comandoResumo(chatId, user_id);
      break;
    default:
      await sendMessage(chatId, "💬 Não entendi. Envie algo como `gastei 100 no mercado` ou `/menu`.");
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
    // intencionalmente sem sendMessage aqui para evitar "Nova transação" duplicado
  })
  .subscribe();


/* ============================================================
🔌 DESCONECTAR TELEGRAM
============================================================ */
app.post("/desconectar-telegram", async (req, res) => {
  const { user_id } = req.body;

  if (!user_id)
    return res.status(400).json({
      success: false,
      message: "Usuário não informado.",
    });

  try {
    const { error: userError } = await supabase
      .from("telegram_users")
      .update({
        conectado: false,
        atualizado_em: new Date(),
      })
      .eq("user_id", user_id);
    if (userError) throw userError;

    const { error: tokenError } = await supabase
      .from("telegram_tokens")
      .update({
        ativo: false,
        usado_em: new Date(),
      })
      .eq("user_id", user_id);
    if (tokenError) throw tokenError;

    console.log(`🔌 Usuário ${user_id} desconectado do Telegram com sucesso.`);
    return res.json({
      success: true,
      message: "🔌 Telegram desconectado com sucesso.",
    });
  } catch (err) {
    console.error("❌ Erro ao desconectar Telegram:", err);
    return res.status(500).json({
      success: false,
      message: "Erro ao desconectar Telegram.",
      error: err.message,
    });
  }
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
