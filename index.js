// index.js — FinanceFlow completo com IA, Categorias, Aprendizado, Hub Familiar,
// Teste de 30 dias (Plano PRO), Token Telegram, Upload IA e Realtime Supabase ↔ Telegram ↔ Horizons

import { parseExtratoUniversal } from "./services/pdfParserUniversal.js";import express from "express";
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
🧠 ANALISAR EXTRATO (IA adaptativa + fallback regex aprimorado)
============================================================ */
app.post("/analisar-extrato", upload.single("file"), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!req.file?.path)
      return res.status(400).json({ success: false, message: "Arquivo não recebido." });

    const filePath = req.file.path;
    const mimetype = req.file.mimetype;
    let textoExtraido = "";

    // 1️⃣ Ler o arquivo conforme tipo
    if (mimetype === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const pdfData = await pdf(buffer);
      textoExtraido = pdfData.text;
    } else if (mimetype.startsWith("image/")) {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("por");
      const { data } = await worker.recognize(filePath);
      textoExtraido = data.text;
      await worker.terminate();
    } else if (
      mimetype === "application/vnd.ms-excel" ||
      mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      textoExtraido = XLSX.utils.sheet_to_csv(sheet);
    } else {
      textoExtraido = fs.readFileSync(filePath, "utf8");
    }

    fs.unlinkSync(filePath);
    if (!textoExtraido || textoExtraido.trim().length < 50) {
      return res.status(400).json({ success: false, message: "Não foi possível ler o extrato." });
    }

    console.log(`📄 Texto extraído: ${textoExtraido.length} caracteres`);

    // 2️⃣ Detectar o banco automaticamente
    function detectarBanco(texto) {
      const lower = texto.toLowerCase();
      if (lower.includes("bradesco")) return "Bradesco";
      if (lower.includes("itaú") || lower.includes("itau")) return "Itaú";
      if (lower.includes("santander")) return "Santander";
      if (lower.includes("nubank")) return "Nubank";
      if (lower.includes("inter")) return "Inter";
      if (lower.includes("caixa")) return "Caixa";
      if (lower.includes("banco do brasil") || lower.includes("banco do brasil s.a.")) return "Banco do Brasil";
      return "Banco Desconhecido";
    }

    const bancoDetectado = detectarBanco(textoExtraido);
    console.log(`🏦 Banco detectado: ${bancoDetectado}`);

    // 3️⃣ Prompt adaptativo por banco
    const prompt = `
Você é um analista financeiro especializado em leitura de extratos bancários do banco **${bancoDetectado}**.
Analise cuidadosamente o conteúdo abaixo e extraia TODAS as transações reais (créditos e débitos), ignorando cabeçalhos, totais, saldos e repetições.

O arquivo pode conter colunas como "Data", "Histórico", "Docto" e "Valor".
O número da coluna "Docto" NÃO é o valor da transação — o valor correto é o último número com vírgula na linha.

Responda SOMENTE com JSON válido no formato:
[
  {"data":"DD/MM/AAAA","descricao":"texto","valor":123.45,"tipo":"entrada|saida"}
]

Regras específicas:
- Use o padrão de data encontrado no extrato (${bancoDetectado} geralmente usa DD/MM/AAAA).
- Se o valor estiver com vírgula, converta para ponto (ex: "1.200,50" → 1200.50).
- Não inclua linhas de “Saldo Anterior”, “Saldo Atual”, “Total do Mês” ou similares.
- Classifique como "entrada" se for crédito, depósito, recebimento, PIX recebido, estorno.
- Classifique como "saida" se for pagamento, compra, tarifa, PIX enviado, débito.
- Caso não encontre transações, devolva um array vazio: [].

Extrato:
"""${textoExtraido.slice(0, 50000)}"""
`;

    console.log("🤖 Enviando extrato completo para IA...");

    // 4️⃣ Chamada à IA
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
    } catch (err) {
      console.warn("⚠️ Falha ao interpretar JSON da IA:", err.message);
    }

    console.log(`📊 IA (${bancoDetectado}) detectou ${transacoesIA.length || 0} transações.`);

    // 5️⃣ Fallback local via regex aprimorado
    const linhas = textoExtraido.split("\n").filter((l) => /\d{2}\/\d{2}\/\d{2,4}/.test(l));
    const transacoesRegex = [];

    for (const linha of linhas) {
      const dataMatch = linha.match(/\d{2}\/\d{2}\/\d{2,4}/);

      // 🧩 Captura todos os valores válidos (com vírgula decimal, aceita negativo e sem milhar)
      const valoresPossiveis = linha.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/g);
      if (!dataMatch || !valoresPossiveis) continue;

      // O último número da linha é o valor da transação (evita Docto e Saldo)
      const valorBruto = valoresPossiveis[valoresPossiveis.length - 1];

      // Ignora números muito longos (provável "Docto")
      const partes = valorBruto.split(",");
      if (partes[0].length > 8 || !/,/.test(valorBruto)) continue;

      const valorNumerico = parseFloat(
        valorBruto.replace(/\./g, "").replace(",", ".").replace("-", "")
      );
      if (isNaN(valorNumerico) || valorNumerico === 0) continue;

      const descricao = linha
        .replace(dataMatch[0], "")
        .replace(valorBruto, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      transacoesRegex.push({
        data: dataMatch[0],
        descricao,
        valor: valorNumerico,
        tipo: /cred|dep|receb|pix/i.test(linha) ? "entrada" : "saida",
      });
    }

    console.log(`📊 Fallback local detectou ${transacoesRegex.length} transações (filtro Docto aprimorado).`);

    // 6️⃣ Combinar resultados IA + Regex
    const combinadas = [...transacoesIA, ...transacoesRegex];

    // 7️⃣ Deduplicação
    const unicas = combinadas.filter(
      (t, idx, arr) =>
        t.data &&
        !isNaN(t.valor) &&
        arr.findIndex(
          (x) =>
            x.data === t.data &&
            x.descricao === t.descricao &&
            Number(x.valor) === Number(t.valor)
        ) === idx
    );

    console.log(`✅ Total final consolidado: ${unicas.length} transações (${bancoDetectado}).`);

    // 8️⃣ Resposta final
    return res.json({
      success: true,
      user_id,
      banco: bancoDetectado,
      count: unicas.length,
      transacoes: unicas,
    });
  } catch (err) {
    console.error("💥 Erro IA:", err);
    res.status(500).json({
      success: false,
      message: "Erro interno ao analisar extrato.",
      error: err.message,
    });
  }
});

/* ============================================================
💾 CONFIRMAR EXTRATO — salvar aprovações no Supabase
============================================================ */
app.post("/confirmar-extrato", async (req, res) => {
  try {
    const { user_id, transacoes } = req.body;

    if (!user_id || !Array.isArray(transacoes))
      return res.status(400).json({ success: false, message: "Dados inválidos." });

    const payload = transacoes.map((t) => ({
      user_id,
      descricao: t.descricao || "",
      valor: Number(t.valor) || 0,
      tipo: t.tipo === "entrada" ? "entrada" : "saida",
      categoria: t.categoria || null,
      data: normalizarData(t.data),
      criado_em: new Date(),
    }));

    const { error } = await supabase.from("transacoes").insert(payload);
    if (error) throw error;

    return res.json({
      success: true,
      message: `✅ ${payload.length} transações salvas com sucesso.`,
    });
  } catch (err) {
    console.error("💥 Erro ao confirmar extrato:", err);
    res.status(500).json({
      success: false,
      message: "Erro ao confirmar extrato.",
      error: err.message,
    });
  }
});

// ============================================================
// 🧠 Função auxiliar — normaliza data DD/MM/AA → YYYY-MM-DD
// ============================================================
function normalizarData(dataBruta) {
  if (!dataBruta) return new Date().toISOString().split("T")[0];
  try {
    const partes = dataBruta.trim().split("/");
    if (partes.length === 3) {
      let [dia, mes, ano] = partes.map((p) => p.padStart(2, "0"));
      if (ano.length === 2) {
        const anoNum = parseInt(ano, 10);
        ano = anoNum < 50 ? `20${ano}` : `19${ano}`;
      }
      return `${ano}-${mes}-${dia}`;
    }
  } catch (err) {
    console.warn("⚠️ Erro ao normalizar data:", dataBruta, err);
  }
  return new Date().toISOString().split("T")[0];
}

/* ============================================================
📤 PROCESSAR EXTRATO (Universal Parser + IA + SUPABASE)
============================================================ */
app.post("/processar-extrato", upload.single("file"), async (req, res) => {
  try {
    console.log("📥 Recebendo arquivo:", req.file?.originalname);
    console.log("🧾 Caminho temporário:", req.file?.path);
    console.log("📦 Tipo MIME:", req.file?.mimetype);

    const { user_id } = req.body;
    if (!user_id)
      return res
        .status(400)
        .json({ success: false, message: "user_id não informado." });

    if (!req.file || !req.file.path) {
      console.error("❌ Falha: arquivo não salvo pelo Multer.");
      return res
        .status(400)
        .json({ success: false, message: "Falha ao armazenar o arquivo." });
    }

    const filePath = req.file.path;
    let fileContent = "";

    // 🧩 Leitura do arquivo conforme tipo (para fallback IA)
    if (req.file.mimetype === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const pdfData = await pdf(buffer);
      fileContent = pdfData.text;
    } else if (
      req.file.mimetype === "application/vnd.ms-excel" ||
      req.file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      fileContent = XLSX.utils.sheet_to_csv(sheet);
    } else {
      fileContent = fs.readFileSync(filePath, "utf8");
    }

    console.log("✅ Arquivo lido com sucesso, tamanho:", fileContent.length);

    /* ============================================================
    🧠 PARSER UNIVERSAL — Detecta banco e extrai dados sem IA
    ============================================================ */
    let extratoIA = [];
    try {
      const resultado = await parseExtratoUniversal(filePath, req.file.mimetype);
      extratoIA = resultado.transacoes;
      console.log(
        `✅ Parser universal identificou ${extratoIA.length} transações (${resultado.banco}).`
      );
    } catch (err) {
      console.error("⚠️ Falha no parser universal:", err);
      extratoIA = [];
    }

    /* ============================================================
    🤖 FALLBACK IA — Se o parser não encontrou nada
    ============================================================ */
    if (!extratoIA.length) {
      console.log("🤖 Fallback IA — interpretando via OpenAI...");

      const prompt = `
      Extraia todas as transações do extrato abaixo e devolva SOMENTE JSON no formato:
      [
        {"data":"DD/MM/AAAA","descricao":"texto","valor":123.45,"tipo":"entrada|saida","categoria":"texto"}
      ]
      Extrato:
      ${fileContent.slice(0, 3000)}
      `;

      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });

      let raw = ai.choices?.[0]?.message?.content?.trim() || "[]";
      console.log("🧠 IA respondeu:", raw.slice(0, 200));

      const jsonStart = raw.indexOf("[");
      const jsonEnd = raw.lastIndexOf("]");
      if (jsonStart >= 0 && jsonEnd >= 0) raw = raw.slice(jsonStart, jsonEnd + 1);

      try {
        extratoIA = JSON.parse(raw);
      } catch (err) {
        console.error("❌ Falha ao interpretar JSON da IA:", err.message);
        return res.status(500).json({
          success: false,
          message: "A IA não retornou JSON válido.",
        });
      }
    }

    console.log("💾 Transações extraídas:", extratoIA.length);

    /* ============================================================
    💾 SALVAR NO SUPABASE
    ============================================================ */
    const payload = extratoIA.map((t) => ({
      user_id,
      descricao: t.descricao || "",
      valor: Number(t.valor) || 0,
      tipo: t.tipo === "entrada" ? "entrada" : "saida",
      categoria: t.categoria || null,
      data: normalizarData(t.data),
      criado_em: new Date(),
    }));

    const { error } = await supabase.from("transacoes").insert(payload);

    // Limpa o arquivo temporário do Render
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn("⚠️ Não foi possível remover arquivo temporário:", err.message);
    }

    if (error) {
      console.error("❌ Erro ao salvar no Supabase:", error);
      return res.status(500).json({
        success: false,
        message: "Erro ao salvar no Supabase.",
        error: error.message,
      });
    }

    return res.json({
      success: true,
      message: `✅ ${payload.length} transações processadas com sucesso.`,
    });
  } catch (err) {
    console.error("💥 Erro inesperado:", err);
    res.status(500).json({
      success: false,
      message: "Erro interno ao processar extrato.",
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
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {
    console.error("⚠️ Erro ao responder callback:", e);
  }
}

async function buscarUsuario(chatId) {
  const chatIdStr = chatId.toString(); // ✅ garantir tipo
  const { data } = await supabase
    .from("telegram_users")
    .select("user_id, family_id, perguntar_essencial")
    .eq("chat_id", chatIdStr)
    .maybeSingle();
  return data || null;
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL (IA) + FALLBACK LOCAL
============================================================ */

// Fallback local para comandos do tipo: +500 mercado / -120 gasolina
function interpretarLocal(text) {
  const m = text.trim().match(/^([+\-])\s*([\d,.]+)\s*(.+)?$/);
  if (!m) return null;
  const sinal = m[1];
  const valorStr = m[2].replace(".", "").replace(",", ".");
  const valor = Number(valorStr);
  if (Number.isNaN(valor)) return null;
  const descricao = (m[3] || "").trim() || (sinal === "+" ? "Entrada" : "Saída");
  return {
    acao: sinal === "+" ? "entrada" : "saida",
    valor,
    descricao,
  };
}

async function interpretarMensagem(text) {
  // 1) tenta parser local simples
  const local = interpretarLocal(text);
  if (local) return local;

  // 2) cai para IA (mantendo sua estrutura original)
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
      family_id: familyId ?? userId, // ✅ fallback seguro para não ficar null
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

   // 🔎 Busca categorias (corrigido e compatível)
  let categorias = [];
  try {
    
    // 🔧 Busca tanto categorias padrão (padrao = true) quanto do usuário atual
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
🔄 CALLBACKS (helpers)
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
🔑 GERAR TOKEN TELEGRAM
============================================================ */
app.post("/gerar-token-telegram", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: "Usuário não informado" });

    const { data: user } = await supabase
      .from("users")
      .select("id, family_id")
      .eq("id", user_id)
      .maybeSingle();
    if (!user) return res.status(404).json({ success: false, message: "Usuário não encontrado" });

    await supabase.from("telegram_tokens").update({ ativo: false }).eq("user_id", user_id);

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
🆓 TESTE PREMIUM DE 30 DIAS (acesso total)
============================================================ */
app.post("/ativar-teste", async (req, res) => {
  const { user_id } = req.body;

  try {
    const { data: usuario } = await supabase
      .from("users")
      .select("plano, trial_ativo, trial_utilizado, trial_expira_em")
      .eq("id", user_id)
      .maybeSingle();

    if (!usuario)
      return res.status(404).json({ success: false, message: "Usuário não encontrado." });

    if (usuario.trial_utilizado)
      return res.json({ success: false, message: "Você já utilizou seu teste gratuito." });

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
        plano: "premium",
        trial_ativo: true,
        trial_utilizado: true,
        trial_expira_em: expiraEm,
      })
      .eq("id", user_id);

    return res.json({
      success: true,
      message: "🧪 Teste Premium ativado com sucesso por 30 dias!",
      expira_em: expiraEm,
    });
  } catch (err) {
    console.error("Erro ao ativar teste:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
💳 ENDPOINT UNIVERSAL — Registrar compra no cartão (Telegram + Web)
============================================================ */
app.post("/registrar-compra-credito", async (req, res) => {
  try {
    const { user_id, family_id, card_id, valor, descricao, parcelas = 1 } = req.body;

    if (!user_id || !card_id || !valor || !descricao) {
      return res.status(400).json({
        success: false,
        message: "Parâmetros incompletos. Envie user_id, card_id, valor e descricao.",
      });
    }

    const { data: card, error: cardError } = await supabase
      .from("cards")
      .select("*")
      .eq("id", card_id)
      .maybeSingle();

    if (cardError || !card) throw new Error("Cartão não encontrado.");

    function calcularDataFatura(diaFechamento, offsetMes = 0) {
      const hoje = new Date();
      return new Date(hoje.getFullYear(), hoje.getMonth() + offsetMes, diaFechamento);
    }

    for (let i = 1; i <= parcelas; i++) {
      const dataFatura = calcularDataFatura(card.dia_fechamento, i - 1);
      const { error: txError } = await supabase.from("transacoes").insert({
        tipo: "saida",
        valor: Number(valor) / parcelas,
        descricao,
        card_id: card.id,
        user_id,
        family_id,
        parcelas,
        parcela_atual: i,
        data_compra: new Date(),
        data_fatura: dataFatura,
        pago: false,
      });
      if (txError) throw txError;
    }

    const { error: saldoError } = await supabase.rpc("atualizar_saldo_cartao", {
      p_card_id: card.id,
      p_valor: Number(valor),
    });
    if (saldoError) throw saldoError;

    return res.json({
      success: true,
      message: `💳 Compra registrada: ${descricao} — R$${Number(valor).toFixed(
        2
      )} (${parcelas}x no cartão ${card.apelido})`,
    });
  } catch (err) {
    console.error("❌ Erro registrar-compra-credito:", err);
    return res.status(500).json({
      success: false,
      message: "Erro ao registrar compra no cartão.",
      error: err.message,
    });
  }
});

/* ============================================================
🤖 WEBHOOK TELEGRAM (com /start, /menu, /help e leitura de foto)
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const body = req.body;
  const msg = body.message;
  if (!msg && !body.callback_query) return res.sendStatus(200);

  // ==============================
  // CALLBACKS (botões)
  // ==============================
  if (body.callback_query) {
    const cb = body.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;
    const user = await buscarUsuario(chatId);
    const userId = user?.user_id;

    console.log("🧩 Callback recebido:", data);
    await sendCallbackAnswer(cb.id, "Processando..."); // ✅ responde rápido ao Telegram

    try {
      // ✅ CONFIRMAR FOTO
      if (data.startsWith("conf_foto_")) {
        const [_, valor, ...descParts] = data.split("_");
        const descricao = decodeURIComponent(descParts.join("_"));
        if (!user) {
          await sendMessage(chatId, "🔒 Conta não vinculada. Use `/vincular TLG-XXXXXX`.");
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
        return res.sendStatus(200);
      }

      // ✏️ CORRIGIR VALOR
      if (data.startsWith("corrigir_")) {
        const descricao = decodeURIComponent(data.replace("corrigir_", ""));
        await sendMessage(chatId, `✏️ Digite o valor correto para *${descricao}* (ex: 152.35):`);

        await supabase.from("telegram_temp").upsert({
          chat_id: chatId.toString(),
          contexto: "corrigir_valor",
          descricao,
          atualizado_em: new Date(),
        });

        return res.sendStatus(200);
      }

      // ❌ CANCELAR
      if (data === "cancelar_foto") {
        await sendMessage(chatId, "❌ Registro cancelado.");
        return res.sendStatus(200);
      }

      // 🗂 CATEGORIA
      if (data.startsWith("cat_")) {
        const [_, transacaoId, ...categoriaParts] = data.split("_");
        const categoria = decodeURIComponent(categoriaParts.join("_"));
        await definirCategoria(transacaoId, categoria, chatId);
        await sendMessage(chatId, `✅ Categoria *${categoria}* aplicada com sucesso!`);
        return res.sendStatus(200);
      }

     // ⚙️ ESSENCIALIDADE 
if (data.startsWith("ess_")) {
  const [_, transacaoId, valor] = data.split("_");

  // responde imediatamente ao Telegram para evitar reenvio do mesmo callback
  try {
    await sendCallbackAnswer(cb.id, "✅ Atualizado!");
  } catch (e) {
    console.warn("⚠️ Falha ao responder callback rapidamente:", e);
  }

  // processa a atualização de forma assíncrona
  definirEssencialidade(transacaoId, valor, chatId, userId)
    .then(() => {
      sendMessage(
        chatId,
        valor === "true"
          ? "🟢 Marcado como *essencial*"
          : "🔴 Marcado como *não essencial*"
      );
    })
    .catch((e) => console.error("❌ Erro definirEssencialidade:", e));

  // encerra imediatamente para o Telegram não repetir o evento
  return res.sendStatus(200);
}

      // 🗑️ CONFIRMAR EXCLUSÃO DE TRANSAÇÃO
      if (data.startsWith("del_")) {
        const [_, transacaoId] = data.split("_");
        const { error } = await supabase.from("transacoes").delete().eq("id", transacaoId);
        if (error) {
          console.error("❌ Erro ao excluir transação:", error);
          await sendMessage(chatId, "⚠️ Erro ao excluir transação. Tente novamente.");
          return res.sendStatus(200);
        }
        await sendMessage(chatId, "🗑️ Última transação apagada com sucesso!");
        return res.sendStatus(200);
      }

      if (data === "cancelar_del") {
        await sendMessage(chatId, "❌ Ação cancelada. Nenhuma transação foi excluída.");
        return res.sendStatus(200);
      }

      console.log("ℹ️ Callback sem ação específica:", data);
      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro ao processar callback:", err);
      try { await sendCallbackAnswer(cb.id, "Erro ao processar ação"); } catch {}
      return res.sendStatus(200);
    }
  }

  // ==============================
  // MENSAGENS
  // ==============================
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // 📸 FOTO (nota fiscal)
  if (msg.photo && msg.photo.length > 0) {
    try {
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

      const worker = await createWorker("por");
      const { data: ocrResult } = await worker.recognize(fileUrl);
      await worker.terminate();

      const textoExtraido = ocrResult.text;
      console.log("🧠 Texto OCR extraído:", textoExtraido.slice(0, 300));

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
        `Detectei *R$${Number(dataExtraida.valor).toFixed(2)}* em *${dataExtraida.descricao}*.\nDeseja registrar essa compra como saída?`,
        replyMarkup
      );

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro OCR+IA:", err);
      await sendMessage(chatId, "⚠️ Ocorreu um erro ao analisar a nota. Tente novamente.");
      return res.sendStatus(200);
    }
  }

  // Comandos básicos
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
        "🧠 IA classifica automaticamente suas transações (com fallback local para + e - ).\n" +
        "👨‍👩‍👧 Hub Familiar: compartilhe o dashboard com sua família.\n" +
        "🔗 /menu — ver comandos\n/start — boas-vindas\n/help — este guia."
    );
    return res.sendStatus(200);
  }

  // Vinculação via token
  if (text?.toLowerCase().startsWith("/vincular")) {
    const parts = text.split(" ");
    const token = parts[1]?.trim();

    if (!token || !token.startsWith("TLG-")) {
      await sendMessage(chatId, "❌ Formato inválido. Envie assim:\n`/vincular TLG-XXXXXX`");
      return res.sendStatus(200);
    }

    const { data: tokenData } = await supabase
      .from("telegram_tokens")
      .select("id, user_id, family_id, ativo")
      .eq("token", token)
      .maybeSingle();

    if (!tokenData || !tokenData.ativo) {
      await sendMessage(chatId, "⚠️ Token inválido ou expirado. Gere um novo no app FinanceFlow.");
      return res.sendStatus(200);
    }

    await supabase.from("telegram_users").delete().eq("chat_id", chatId.toString());

    let familyId = tokenData.family_id;
    if (!familyId) {
      const { data: userData } = await supabase
        .from("users")
        .select("family_id")
        .eq("id", tokenData.user_id)
        .maybeSingle();
      familyId = userData?.family_id || null;
    }

    const { error: upsertError } = await supabase.from("telegram_users").insert({
      chat_id: chatId.toString(),
      user_id: tokenData.user_id,
      family_id: familyId,
      perguntar_essencial: true,
      conectado: true,
      atualizado_em: new Date(),
      criado_em: new Date(),
    });
    if (upsertError) {
      console.error("❌ Erro ao vincular Telegram:", upsertError);
      await sendMessage(chatId, "⚠️ Erro ao vincular conta. Tente novamente.");
      return res.sendStatus(200);
    }

    await supabase
      .from("telegram_tokens")
      .update({ ativo: false, usado_em: new Date() })
      .eq("id", tokenData.id);

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

  // Desvincular
  if (text?.toLowerCase() === "/desvincular") {
    const chatIdStr = chatId.toString();

    try {
      const { data: vinculo } = await supabase
        .from("telegram_users")
        .select("id, user_id, conectado")
        .eq("chat_id", chatIdStr)
        .maybeSingle();

      if (!vinculo) {
        await sendMessage(chatId, "⚠️ Nenhuma conta vinculada a este chat.");
        return res.sendStatus(200);
      }

      await supabase.from("telegram_users").delete().eq("chat_id", chatIdStr);

      console.log(`🔌 Conta desvinculada do Telegram: chat_id ${chatIdStr}`);
      await sendMessage(
        chatId,
        "🔓 Sua conta foi *desvinculada com sucesso!*.\n\n" +
          "Se quiser conectar novamente, gere um novo token no app e envie:\n" +
          "`/vincular TLG-XXXXXX`"
      );

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro ao desvincular conta:", err);
      await sendMessage(chatId, "⚠️ Ocorreu um erro ao tentar desvincular. Tente novamente.");
      return res.sendStatus(200);
    }
  }

  // Desfazer / apagar
  if (text?.toLowerCase() === "/desfazer" || text?.toLowerCase() === "/apagar") {
    const user = await buscarUsuario(chatId);
    if (!user) {
      await sendMessage(chatId, "🔒 Conta não vinculada. Use `/vincular TLG-XXXXXX`.");
      return res.sendStatus(200);
    }

    const { data: ultima, error } = await supabase
      .from("transacoes")
      .select("id, descricao, valor, tipo, created_at")
      .eq("user_id", user.user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !ultima) {
      await sendMessage(chatId, "📭 Nenhuma transação recente encontrada.");
      return res.sendStatus(200);
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Sim, excluir", callback_data: `del_${ultima.id}` },
          { text: "❌ Cancelar", callback_data: "cancelar_del" },
        ],
      ],
    };

    await sendMessage(
      chatId,
      `Tem certeza que deseja apagar a última transação?\n\n` +
        `${ultima.tipo === "entrada" ? "💰" : "💸"} *${ultima.descricao}* — R$${Number(ultima.valor).toFixed(2)}\n` +
        `(${new Date(ultima.created_at).toLocaleString("pt-BR")})`,
      replyMarkup
    );

    return res.sendStatus(200);
  }

  // Registro via IA + fallback
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
      await sendMessage(chatId, "💬 Não entendi. Envie algo como `+500 presente`, `-120 gasolina` ou `/menu`.");
  }

  return res.sendStatus(200);
});

/* ============================================================
🔁 SUPABASE REALTIME ↔ TELEGRAM ↔ FRONT (sem duplicação)
============================================================ */
const supabaseRealtime = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
supabaseRealtime
  .channel("transacoes_updates")
  .on("postgres_changes", { event: "*", schema: "public", table: "transacoes" }, async (payload) => {
    console.log("📡 Mudança detectada em transações:", payload.eventType, payload.new);
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
🧹 LIMPAR HISTÓRICO — ENTRADAS, SAÍDAS E DADOS COMPLETOS
============================================================ */

// 🔹 1️⃣ Apenas Entradas e Saídas
app.post("/limpar-transacoes", async (req, res) => {
  const { user_id } = req.body;
  if (!user_id)
    return res.status(400).json({ success: false, message: "Usuário não informado." });

  try {
    await supabase.from("transacoes").delete().eq("user_id", user_id);
    await supabase.from("memoria_essenciais").delete().eq("user_id", user_id);

    return res.json({ success: true, message: "🧾 Entradas e saídas apagadas com sucesso." });
    
    await supabase.from("logs_limpeza").insert({
  user_id,
  tipo_limpeza: "transacoes",
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

// 🔹 2️⃣ Limpeza Completa (menos Telegram e plano)
app.post("/limpar-dados-completos", async (req, res) => {
  const { user_id } = req.body;
  if (!user_id)
    return res.status(400).json({ success: false, message: "Usuário não informado." });

  try {
    const tabelas = [
      "transacoes",
      "cards",
      "dividas",
      "relatorios_ia",
      "investimentos",
      "gestor_assinaturas",
      "alertas_ia",
      "memoria_essenciais",
    ];

    for (const tabela of tabelas) {
      const { error } = await supabase.from(tabela).delete().eq("user_id", user_id);
      if (error) console.warn(`⚠️ Erro ao limpar ${tabela}:`, error.message);
    }

    return res.json({
      success: true,
      message: "💣 Todos os dados financeiros e IA foram apagados com sucesso.",
    });

    await supabase.from("logs_limpeza").insert({
  user_id,
  tipo_limpeza: "completa",
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
🕒 VERIFICAÇÃO AUTOMÁTICA DE TESTES EXPIRADOS
============================================================ */
app.post("/verificar-trials", async (req, res) => {
  try {
    const hoje = new Date();

    const { data: expirados } = await supabase
      .from("users")
      .select("id, plano")
      .eq("trial_ativo", true)
      .lte("trial_expira_em", hoje.toISOString());

    for (const usr of expirados || []) {
      await supabase
        .from("users")
        .update({ trial_ativo: false, plano: "starter" })
        .eq("id", usr.id);
    }

    console.log(`🕒 Trials expirados verificados: ${expirados?.length || 0}`);
    res.json({ success: true, count: expirados?.length || 0 });
  } catch (err) {
    console.error("Erro ao verificar trials:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
