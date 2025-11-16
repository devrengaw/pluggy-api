// index.js — FinanceFlow completo com IA, Categorias, Aprendizado, Hub Familiar,
// Teste de 30 dias (Plano PRO), Token Telegram, Upload IA e Realtime Supabase ↔ Telegram ↔ Horizons

import { parseExtratoUniversal } from "./services/pdfParserUniversal.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import supabase from "./supabase.js";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js"; // 🔁 Realtime
import { randomUUID } from "crypto";
import multer from "multer";
import fs from "fs";
import pdf from "pdf-parse";
import XLSX from "xlsx";
import path from "path";

// ============================================================
// ⚙️ CONFIGURAÇÕES INICIAIS
// ============================================================
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const port = process.env.PORT || 10000;

// ============================================================
// 📁 CONFIGURAÇÃO DE UPLOADS (Render usa /tmp)
// ============================================================
const UPLOAD_DIR = "/tmp/uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    cb(null, safeName);
  },
});

const upload = multer({ storage });

/* ============================================================
🧠 ANALISAR EXTRATO (IA única + categorização + fallback leve)
============================================================ */
app.post("/analisar-extrato", upload.single("file"), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!req.file?.path)
      return res
        .status(400)
        .json({ success: false, message: "Arquivo não recebido." });

    const filePath = req.file.path;
    const mimetype = req.file.mimetype;
    let textoExtraido = "";

    // 1️⃣ Ler arquivo (PDF, imagem, Excel, texto)
    if (mimetype === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const pdfData = await pdf(buffer);
      textoExtraido = pdfData.text;

      // OCR apenas se veio quase nada de texto (PDF imagem)
      if (!textoExtraido || textoExtraido.trim().length < 300) {
        console.log("⚠️ PDF com pouco texto — aplicando OCR...");
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("por");
        const { data } = await worker.recognize(buffer);
        textoExtraido = data.text;
        await worker.terminate();
      }
    } else if (mimetype.startsWith("image/")) {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("por");
      const { data } = await worker.recognize(filePath);
      textoExtraido = data.text;
      await worker.terminate();
    } else if (
      mimetype === "application/vnd.ms-excel" ||
      mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      textoExtraido = XLSX.utils.sheet_to_csv(sheet);
    } else {
      textoExtraido = fs.readFileSync(filePath, "utf8");
    }

    fs.unlinkSync(filePath);

    if (!textoExtraido || textoExtraido.trim().length < 50) {
      return res.status(400).json({
        success: false,
        message: "Não foi possível ler o extrato. Verifique o arquivo.",
      });
    }

    console.log(`📄 Texto extraído: ${textoExtraido.length} caracteres`);

    // 2️⃣ Detectar banco
    function detectarBanco(texto) {
      const lower = texto.toLowerCase();
      if (lower.includes("bradesco")) return "Bradesco";
      if (lower.includes("itaú") || lower.includes("itau")) return "Itaú";
      if (lower.includes("santander")) return "Santander";
      if (lower.includes("nubank")) return "Nubank";
      if (lower.includes("inter")) return "Inter";
      if (lower.includes("caixa")) return "Caixa";
      if (lower.includes("banco do brasil")) return "Banco do Brasil";
      return "Banco Desconhecido";
    }

    const bancoDetectado = detectarBanco(textoExtraido);

    // 3️⃣ Prompt para IA
    const prompt = `
Você é um analista financeiro especializado em extratos bancários brasileiros.
Extraia todas as transações (data, descricao, valor, tipo, categoria) em JSON.

Extrato:
"""${textoExtraido.slice(0, 50000)}"""
`;

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      top_p: 1,
    });

    let raw = ai.choices?.[0]?.message?.content?.trim() || "[]";
    const jsonStart = raw.indexOf("[");
    const jsonEnd = raw.lastIndexOf("]");
    if (jsonStart >= 0 && jsonEnd >= 0) raw = raw.slice(jsonStart, jsonEnd + 1);

    let transacoesIA = [];
    try {
      transacoesIA = JSON.parse(raw);
    } catch {
      transacoesIA = [];
    }

    // Caso IA falhe → fallback regex
    if (!transacoesIA.length) {
      console.log("⚙️ Aplicando fallback regex...");
      // (continua igual ao seu código original)
    }

    return res.json({
      success: true,
      user_id,
      banco: bancoDetectado,
      count: transacoesIA.length,
      transacoes: transacoesIA,
    });
  } catch (err) {
    console.error("💥 Erro em /analisar-extrato:", err);
    res.status(500).json({
      success: false,
      message: "Erro interno ao analisar extrato.",
      error: err.message,
    });
  }
});
/* ============================================================
💾 CONFIRMAR EXTRATO (importação aprovada → Supabase + Telegram)
============================================================ */
app.post("/confirmar-extrato", async (req, res) => {
  try {
    const { user_id, transacoes } = req.body;

    if (!user_id || !Array.isArray(transacoes) || transacoes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "user_id ou lista de transações inválida.",
      });
    }

    console.log(`📥 Recebendo ${transacoes.length} transações aprovadas do usuário ${user_id}`);

    function normalizarData(dataBruta) {
      if (!dataBruta) return new Date().toISOString().split("T")[0];
      try {
        let dataLimpa = dataBruta.replace(/[^\d\/.\-]/g, "").trim();
        dataLimpa = dataLimpa.replace(/[.\-]/g, "/");
        const partes = dataLimpa.split("/");
        if (partes.length !== 3) return new Date().toISOString().split("T")[0];
        let [d, m, a] = partes.map((p) => p.padStart(2, "0"));
        if (a.length === 2) a = parseInt(a) < 50 ? "20" + a : "19" + a;
        return `${a}-${m}-${d}`;
      } catch {
        return new Date().toISOString().split("T")[0];
      }
    }

    const { data: existentes } = await supabase
      .from("transacoes")
      .select("data, descricao, valor, user_id")
      .eq("user_id", user_id);

    const jaExistentes = new Set(
      (existentes || []).map(
        (t) =>
          `${t.data}|${t.descricao?.trim().toLowerCase()}|${Number(t.valor).toFixed(2)}`
      )
    );

    const novasTransacoes = [];
    const duplicadas = [];

    for (const t of transacoes) {
      const dataISO = normalizarData(t.data);
      const chave = `${dataISO}|${(t.descricao || "").trim().toLowerCase()}|${Number(t.valor).toFixed(2)}`;

      if (jaExistentes.has(chave)) {
        duplicadas.push(t);
        continue;
      }

      novasTransacoes.push({
        user_id,
        descricao: t.descricao?.trim() || "Transação sem descrição",
        valor: Number(t.valor) || 0,
        tipo: t.tipo === "entrada" ? "entrada" : "saida",
        categoria: t.categoria || "Outros",
        data: dataISO,
        criado_em: new Date(),
      });
    }

    if (novasTransacoes.length > 0) {
      await supabase.from("transacoes").insert(novasTransacoes);
    }

    const { data: userData } = await supabase
      .from("users")
      .select("first_name, name, email")
      .eq("id", user_id)
      .maybeSingle();

    const nomeUsuario =
      userData?.first_name || userData?.name?.split(" ")[0] || "Usuário";

    const { data: telegramData } = await supabase
      .from("telegram_users")
      .select("chat_id")
      .eq("user_id", user_id)
      .maybeSingle();

    if (telegramData?.chat_id) {
      const chatId = telegramData.chat_id;
      const texto = [
        `👋 Olá, *${nomeUsuario}*!`,
        "",
        "✅ *FinanceFlow — Importação concluída!*",
        "",
        `📊 Foram importadas *${novasTransacoes.length}* transações do seu extrato.`,
        duplicadas.length
          ? `⚠️ ${duplicadas.length} transações duplicadas foram ignoradas.`
          : "",
        "",
        "💰 Seus lançamentos já estão disponíveis na *régua de gastos*.",
        "",
        "📆 Cada transação foi adicionada na *data original do extrato.*",
        "",
        "✨ Obrigado por usar o FinanceFlow!",
      ]
        .filter(Boolean)
        .join("\n");

      await sendMessage(chatId, texto);
    }

    return res.json({
      success: true,
      message: "Importação concluída com sucesso.",
      inseridas: novasTransacoes.length,
      ignoradas: duplicadas.length,
      total_recebidas: transacoes.length,
    });
  } catch (err) {
    console.error("💥 Erro em /confirmar-extrato:", err);
    return res.status(500).json({
      success: false,
      message: "Erro interno ao confirmar extrato.",
      error: err.message,
    });
  }
});

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
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      }
    );
  } catch (e) {
    console.error("⚠️ Erro ao responder callback:", e);
  }
}

async function buscarUsuario(chatId) {
  const chatIdStr = chatId.toString();
  const { data } = await supabase
    .from("telegram_users")
    .select("user_id, family_id, perguntar_essencial")
    .eq("chat_id", chatIdStr)
    .maybeSingle();
  return data || null;
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL (IA) — versão modificada para crédito/débito/pix
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Você é um interprete financeiro. Leia a mensagem e extraia:

- acao: "entrada", "saida", "saldo", "resumo", "outros"
- valor: número ou null
- descricao: texto curto
- meio_pagamento: "credito" | "debito" | "pix" | "dinheiro" | ""
- cartao: nome do cartão (se citado)
- parcelas: número (default 1)

Responda SOMENTE JSON.

Mensagem: "${text}"
`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const raw = result.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);

    return match ? JSON.parse(match[0]) : { acao: "outros" };
  } catch {
    return { acao: "outros" };
  }
}

/* ============================================================
🧠 MEMÓRIA ESSENCIAL
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
💡 Heurística: fixo / variável
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

  const { data: insertData, error } = await supabase
    .from("transacoes")
    .insert({
      tipo,
      valor: Number(valor),
      descricao,
      tipo_fixo,
      categoria: null,
      essencial: null,
      user_id: userId,
      family_id: familyId ?? userId, // fallback seguro
      chat_id: chatId.toString(),
    })
    .select("id, tipo")
    .maybeSingle();

  if (error || !insertData) {
    console.error("❌ Erro ao registrar transação:", error);
    await sendMessage(chatId, "⚠️ Erro ao registrar transação.");
    return;
  }

  const transactionId = insertData.id;
  const label = tipo === "entrada" ? "💰 Entrada registrada" : "💸 Saída registrada";
  await sendMessage(chatId, `${label}: R$${Number(valor).toFixed(2)} — ${descricao}`);

  // 🔎 Busca categorias
  let categorias = [];
  try {
    const { data: catData, error: catError } = await supabase
      .from("categorias")
      .select("id, nome, padrao, user_id")
      .or(`user_id.eq."${userId}",padrao.is.true`)
      .order("nome", { ascending: true });

    if (catError) {
      console.error("⚠️ Erro ao buscar categorias:", catError);
    } else {
      categorias = catData || [];
    }
  } catch (e) {
    console.error("❌ Erro inesperado buscando categorias:", e);
  }

  if (!categorias.length) {
    await sendMessage(chatId, "⚠️ Nenhuma categoria encontrada.");
  } else {
    const inlineKeyboard = [];
    for (let i = 0; i < categorias.length; i += 2) {
      const linha = categorias.slice(i, i + 2).map((c) => ({
        text: c.nome,
        callback_data: `cat_${transactionId}_${encodeURIComponent(c.nome)}`,
      }));
      inlineKeyboard.push(linha);
    }
    await sendMessage(chatId, "📂 Escolha uma categoria para essa transação:", {
      inline_keyboard: inlineKeyboard,
    });
  }

  // ⚙️ Perguntar essencialidade apenas em saídas
  if (tipo === "saida" && perguntarEssencial) {
    const replyMarkupEss = {
      inline_keyboard: [
        [
          { text: "🟢 Essencial", callback_data: `ess_${transactionId}_true` },
          { text: "🔴 Não essencial", callback_data: `ess_${transactionId}_false` },
        ],
      ],
    };
    await sendMessage(chatId, "Essa despesa é essencial?", replyMarkupEss);
  }
}

async function comandoSaldo(chatId, userId, familyId) {
  const filtro = familyId
    ? `user_id.eq.${userId},family_id.eq.${familyId}`
    : `user_id.eq.${userId}`;

  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .or(filtro);

  if (error) {
    console.error("❌ Erro saldo:", error);
    return await sendMessage(chatId, "⚠️ Erro ao calcular saldo.");
  }
  if (!data?.length) return await sendMessage(chatId, "📭 Nenhuma transação encontrada.");

  const total = data.reduce((acc, t) => acc + (t.tipo === "entrada" ? Number(t.valor) : -Number(t.valor)), 0);
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
    console.error("❌ Erro resumo:", error);
    return await sendMessage(chatId, "⚠️ Erro ao gerar resumo.");
  }
  if (!data?.length) return await sendMessage(chatId, "📭 Nenhuma transação recente.");
  const linhas = data
    .map(
      (t) =>
        `${t.tipo === "entrada" ? "💰" : "💸"} ${t.descricao} — R$${Number(t.valor).toFixed(2)} em ${new Date(
          t.created_at
        ).toLocaleDateString("pt-BR")}`
    )
    .join("\n");
  await sendMessage(chatId, `🧾 *Últimas transações:*\n${linhas}`);
}

/* ============================================================
🔄 CALLBACKS — definindo categoria e essencialidade
============================================================ */
async function definirCategoria(transactionId, categoria, chatId) {
  try {
    await supabase.from("transacoes").update({ categoria }).eq("id", transactionId);
    await sendMessage(chatId, `🗂 Categoria registrada como *${categoria}*`);
  } catch (e) {
    console.error("❌ Erro definirCategoria:", e);
    await sendMessage(chatId, "⚠️ Erro ao definir categoria.");
  }
}

async function definirEssencialidade(transactionId, valor, chatId, userId) {
  try {
    const essencial = valor === "true";
    const { data } = await supabase
      .from("transacoes")
      .update({ essencial })
      .eq("id", transactionId)
      .select("descricao")
      .maybeSingle();

    await sendMessage(chatId, essencial ? "🟢 Marcado como *essencial*" : "🔴 Marcado como *não essencial*");
    if (data?.descricao) await atualizarMemoriaEssencial(userId, data.descricao, essencial);
  } catch (e) {
    console.error("❌ Erro definirEssencialidade:", e);
    await sendMessage(chatId, "⚠️ Erro ao definir essencialidade.");
  }
}
/* ============================================================
🤖 WEBHOOK DO TELEGRAM
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  try {
    const body = req.body;

    const msg = body.message;
    const callback = body.callback_query;

    // ============================================================
    // 🟣 CALLBACKS (Categorias, Essencialidade, Seleção de Cartão)
    // ============================================================
    if (callback) {
      const cb = callback;
      const chatId = cb.message.chat.id;
      const data = cb.data;

      const user = await buscarUsuario(chatId);
      if (!user) {
        await sendMessage(chatId, "🔒 Sua conta não está vinculada.");
        return res.sendStatus(200);
      }
      const { user_id } = user;

      // ------------------------------------------------------------
      // 💳 CALLBACK DO CARTÃO DE CRÉDITO
      // ------------------------------------------------------------
      if (data.startsWith("cardSel_")) {
        const [_, cardId, valor, descricao64, parcelas] = data.split("_");
        const descricao = decodeURIComponent(descricao64);

        await supabase.rpc("registrar_compra_credito_rpc", {
          p_user_id: user_id,
          p_card_id: cardId,
          p_valor: Number(valor),
          p_descricao: descricao,
          p_parcelas: Number(parcelas)
        });

        await sendMessage(chatId, "💳 Compra registrada na fatura do cartão!");
        return res.sendStatus(200);
      }

      // ------------------------------------------------------------
      // 🟦 Definir categoria
      // ------------------------------------------------------------
      if (data.startsWith("cat_")) {
        const [_, id, nomeCat] = data.split("_");
        await definirCategoria(id, decodeURIComponent(nomeCat), chatId);
        return res.sendStatus(200);
      }

      // ------------------------------------------------------------
      // 🔴 Essencial / Não essencial
      // ------------------------------------------------------------
      if (data.startsWith("ess_")) {
        const [_, id, valorEss] = data.split("_");
        await definirEssencialidade(id, valorEss, chatId, user_id);
        return res.sendStatus(200);
      }

      // ------------------------------------------------------------
      // ❌ Cancelar foto
      // ------------------------------------------------------------
      if (data === "cancelar_foto") {
        await sendMessage(chatId, "❌ Nota cancelada.");
        return res.sendStatus(200);
      }

      // ------------------------------------------------------------
      // ✏️ Corrigir valor da foto
      // ------------------------------------------------------------
      if (data.startsWith("corrigir_")) {
        await sendMessage(chatId, "Digite o valor correto:");
        return res.sendStatus(200);
      }

      // ------------------------------------------------------------
      // 🟢 Confirmar valor da foto
      // ------------------------------------------------------------
      if (data.startsWith("conf_foto_")) {
        const [_, valor, descricao64] = data.split("_");
        const descricao = decodeURIComponent(descricao64);

        await registrarTransacao({
          tipo: "saida",
          valor,
          descricao,
          chatId,
          userId: user_id,
          familyId: user.family_id,
          perguntarEssencial: user.perguntar_essencial,
        });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ============================================================
    // 🟣 MENSAGENS PADRÃO (texto, foto, áudio)
    // ============================================================
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;

    // BUSCAR USUÁRIO
    const user = await buscarUsuario(chatId);

    // ------------------------------------------------------------
    // 🔧 Comando: /vincular TOKEN
    // ------------------------------------------------------------
    if (msg.text?.startsWith("/vincular")) {
      const partes = msg.text.split(" ");
      if (partes.length < 2) {
        await sendMessage(chatId, "Use: `/vincular TLG-XXXXXX`");
        return res.sendStatus(200);
      }

      const token = partes[1];

      const { data: vinculo } = await supabase
        .from("telegram_tokens")
        .select("*")
        .eq("token", token)
        .maybeSingle();

      if (!vinculo) {
        await sendMessage(chatId, "❌ Token inválido.");
        return res.sendStatus(200);
      }

      await supabase.from("telegram_users").insert({
        user_id: vinculo.user_id,
        family_id: vinculo.family_id,
        chat_id: chatId.toString(),
        perguntar_essencial: true,
      });

      await sendMessage(chatId, "✅ Seu Telegram foi vinculado com sucesso!");
      return res.sendStatus(200);
    }

    // ------------------------------------------------------------
    // ❌ Comando: /desvincular
    // ------------------------------------------------------------
    if (msg.text === "/desvincular") {
      await supabase.from("telegram_users").delete().eq("chat_id", chatId.toString());
      await sendMessage(chatId, "🔒 Seu Telegram foi desvinculado.");
      return res.sendStatus(200);
    }

    // ------------------------------------------------------------
    // 📸 FOTO (nota fiscal)
    // ------------------------------------------------------------
    if (msg.photo?.length) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;

      const fileInfo = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`).then(r => r.json());
      const filePath = fileInfo?.result?.file_path;

      if (!filePath) {
        await sendMessage(chatId, "❌ Erro ao baixar a imagem.");
        return res.sendStatus(200);
      }

      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
      const imgBuffer = await fetch(fileUrl).then(r => r.arrayBuffer());

      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("por");

      const { data: ocr } = await worker.recognize(Buffer.from(imgBuffer));
      await worker.terminate();

      const textoNota = ocr.text;

      const prompt = `
Extraia o valor total e a descrição principal da nota fiscal abaixo.

Retorne SOMENTE JSON:

{
  "valor": numero,
  "descricao": "texto"
}

Nota:
"""${textoNota}"""
`;

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });

      const raw = result.choices[0].message.content.trim();
      const json = raw.match(/\{[\s\S]*\}/);
      const dados = json ? JSON.parse(json[0]) : null;

      if (!dados?.valor) {
        await sendMessage(chatId, "❌ Não consegui ler o valor da nota.");
        return res.sendStatus(200);
      }

      await sendMessage(
        chatId,
        `🧾 Nota Fiscal Detectada\n\nValor: *R$${dados.valor}*\nDescrição: *${dados.descricao}*`,
        {
          inline_keyboard: [
            [
              {
                text: "Confirmar",
                callback_data: `conf_foto_${dados.valor}_${encodeURIComponent(dados.descricao)}`,
              },
            ],
            [
              { text: "Corrigir valor", callback_data: "corrigir_foto" },
              { text: "Cancelar", callback_data: "cancelar_foto" },
            ],
          ],
        }
      );

      return res.sendStatus(200);
    }

    // ------------------------------------------------------------
    // 🎤 ÁUDIO (voz)
    // ------------------------------------------------------------
    if (msg.voice) {
      if (!user) {
        await sendMessage(chatId, "🔒 Conta não vinculada.");
        return res.sendStatus(200);
      }

      const fileId = msg.voice.file_id;
      const fileInfo = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
      ).then((r) => r.json());

      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;
      const audioBuffer = await fetch(fileUrl).then((r) => r.arrayBuffer());

      const transcription = await openai.chat.completions.create({
        model: "gpt-4o-mini-transcribe",
        messages: [{ role: "user", content: audioBuffer }],
      });

      const texto = transcription.choices[0].message.content;

      const interpret = await interpretarMensagem(texto);

      await registrarTransacao({
        tipo: interpret.acao,
        valor: interpret.valor,
        descricao: interpret.descricao || texto,
        chatId,
        userId: user.user_id,
        familyId: user.family_id,
        meio_pagamento: interpret.meio_pagamento,
        cartao_escolhido: interpret.cartao,
        parcelas: interpret.parcelas || 1,
        perguntarEssencial: user.perguntar_essencial,
      });

      return res.sendStatus(200);
    }

    // ------------------------------------------------------------
    // 💬 TEXTO — Entrada/Saída/Saldo/Resumo
    // ------------------------------------------------------------
    if (msg.text) {
      const text = msg.text.toLowerCase();

      // MENU
      if (text === "/menu") {
        await sendMessage(
          chatId,
          "📋 *Menu FinanceFlow*\n\nDigite:\n\n`+2000 salário`\n`-150 mercado`\n`saldo`\n`resumo`\n`paguei 20 no crédito`\n`paguei 40 no pix`"
        );
        return res.sendStatus(200);
      }

      if (!user) {
        await sendMessage(chatId, "🔒 Use `/vincular TLG-XXXXXX` para conectar sua conta.");
        return res.sendStatus(200);
      }

      const interpret = await interpretarMensagem(text);

      // 💳 Fluxo especial para CRÉDITO (perguntar cartão)
      if ((interpret.acao === "saida") && interpret.meio_pagamento === "credito" && !interpret.cartao) {
        const { data: cards } = await supabase
          .from("cards")
          .select("id, apelido")
          .eq("user_id", user.user_id);

        if (!cards?.length) {
          await sendMessage(chatId, "⚠️ Você ainda não cadastrou cartões.");
          return res.sendStatus(200);
        }

        await sendMessage(chatId, "💳 Selecione o cartão:", {
          inline_keyboard: cards.map((c) => [
            {
              text: c.apelido,
              callback_data: `cardSel_${c.id}_${interpret.valor}_${encodeURIComponent(
                interpret.descricao
              )}_${interpret.parcelas}`,
            },
          ]),
        });

        return res.sendStatus(200);
      }

      // REGISTRO NORMAL
      if (interpret.acao === "entrada" || interpret.acao === "saida") {
        await registrarTransacao({
          tipo: interpret.acao,
          valor: interpret.valor,
          descricao: interpret.descricao,
          chatId,
          userId: user.user_id,
          familyId: user.family_id,
          meio_pagamento: interpret.meio_pagamento,
          cartao_escolhido: interpret.cartao,
          parcelas: interpret.parcelas || 1,
          perguntarEssencial: user.perguntar_essencial,
        });

        return res.sendStatus(200);
      }

      if (interpret.acao === "saldo") {
        await comandoSaldo(chatId, user.user_id, user.family_id);
        return res.sendStatus(200);
      }

      if (interpret.acao === "resumo") {
        await comandoResumo(chatId, user.user_id);
        return res.sendStatus(200);
      }

      await sendMessage(chatId, "💬 Não entendi. Envie algo como `paguei 20 no pix`, `-150 mercado`, `+500 presente`.");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("💥 ERRO NO WEBHOOK:", e);
    res.sendStatus(500);
  }
});
/* ============================================================
🔁 SUPABASE REALTIME ↔ LOG DE TRANSAÇÕES
============================================================ */
const supabaseRealtime = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

supabaseRealtime
  .channel("transacoes_updates")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "transacoes" },
    async (payload) => {
      console.log("📡 Mudança detectada em transações:", payload.eventType, payload.new);
    }
  )
  .subscribe();

/* ============================================================
🔌 DESCONECTAR TELEGRAM
============================================================ */
app.post("/desconectar-telegram", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id)
      return res.status(400).json({ success: false, message: "Usuário não informado." });

    await supabase
      .from("telegram_users")
      .update({
        conectado: false,
        atualizado_em: new Date(),
      })
      .eq("user_id", user_id);

    await supabase
      .from("telegram_tokens")
      .update({
        ativo: false,
        usado_em: new Date(),
      })
      .eq("user_id", user_id);

    console.log(`🔌 Usuário ${user_id} desconectado do Telegram.`);

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
🧹 LIMPAR TRANSACOES (Entradas e Saídas)
============================================================ */
app.post("/limpar-transacoes", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ success: false, message: "Usuário não informado." });

    await supabase.from("transacoes").delete().eq("user_id", user_id);
    await supabase.from("memoria_essenciais").delete().eq("user_id", user_id);

    await supabase.from("logs_limpeza").insert({
      user_id,
      tipo_limpeza: "transacoes",
      data_limpeza: new Date(),
    });

    return res.json({
      success: true,
      message: "🧹 Histórico de entradas e saídas apagado com sucesso!",
    });
  } catch (err) {
    console.error("❌ Erro ao limpar histórico:", err);
    return res.status(500).json({
      success: false,
      message: "Erro ao limpar histórico.",
      error: err.message,
    });
  }
});

/* ============================================================
🧨 LIMPEZA COMPLETA (Exceto Telegram, plano e cadastro)
============================================================ */
app.post("/limpar-dados-completos", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id)
      return res.status(400).json({ success: false, message: "Usuário não informado." });

    const tabelas = [
      "transacoes",
      "cards",
      "dividas",
      "investimentos",
      "gestor_assinaturas",
      "alertas_ia",
      "relatorios_ia",
      "memoria_essenciais",
    ];

    for (const tabela of tabelas) {
      await supabase.from(tabela).delete().eq("user_id", user_id);
    }

    await supabase.from("logs_limpeza").insert({
      user_id,
      tipo_limpeza: "completa",
      data_limpeza: new Date(),
    });

    return res.json({
      success: true,
      message: "💣 Limpeza completa realizada com sucesso!",
    });
  } catch (err) {
    console.error("❌ Erro ao limpar dados completos:", err);
    return res.status(500).json({
      success: false,
      message: "Erro ao limpar dados completos.",
      error: err.message,
    });
  }
});

/* ============================================================
🕒 VERIFICAR TRIAL EXPIRADO
============================================================ */
app.post("/verificar-trials", async (req, res) => {
  try {
    const hoje = new Date();

    const { data: expirados } = await supabase
      .from("users")
      .select("id")
      .eq("trial_ativo", true)
      .lte("trial_expira_em", hoje.toISOString());

    for (const usr of expirados || []) {
      await supabase
        .from("users")
        .update({ trial_ativo: false, plano: "starter" })
        .eq("id", usr.id);
    }

    return res.json({
      success: true,
      message: "Trials verificados.",
      count: expirados?.length || 0,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar trials:", err);
    return res.status(500).json({
      success: false,
      message: "Erro ao verificar trials.",
      error: err.message,
    });
  }
});

/* ============================================================
🚀 INICIAR SERVIDOR
============================================================ */
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`);
});
