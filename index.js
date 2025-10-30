// index.js — FinanceFlow com IA, Hub Familiar e Categorias via Telegram
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
🔧 UTILITÁRIOS BÁSICOS
============================================================ */
async function sendMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
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
🧠 CLASSIFICAÇÃO DE TIPO E FIXO/VARIÁVEL
============================================================ */
function classificarFixoOuVariavel(texto) {
  const lower = texto.toLowerCase();
  const palavrasFixas = [
    "salário", "salario", "mensal", "fixo", "aluguel", "conta", "assinatura",
    "internet", "plano", "spotify", "netflix", "academia", "luz", "água", "agua"
  ];

  let tipoFixo = "variavel";
  for (const palavra of palavrasFixas) {
    if (lower.includes(palavra)) {
      tipoFixo = "fixa";
      break;
    }
  }
  return tipoFixo;
}

/* ============================================================
🧠 INTERPRETAÇÃO NATURAL (GPT)
============================================================ */
async function interpretarMensagem(text) {
  const prompt = `
Analise a mensagem abaixo e classifique:
- "entrada" → ganhos, recebimentos, salário, etc.
- "saida" → despesas, gastos, compras, contas, etc.
- "consulta" → perguntas sobre saldo, resumo, etc.
- "outros" → se não se encaixar.

Extraia também:
- valor (número)
- descrição
- se for possível, identifique se é fixa ou variável.

Retorne JSON assim:
{"acao":"entrada|saida|consulta|outros","valor":123.45,"descricao":"texto","tipo_fixo":"fixa|variavel|duvida"}
Mensagem: "${text}"
  `;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });
    const json = result.choices[0].message.content.match(/\{[\s\S]*\}/);
    const parsed = json ? JSON.parse(json[0]) : null;

    if (!parsed) return { acao: "outros", valor: null, descricao: text, tipo_fixo: "duvida" };
    if (!parsed.tipo_fixo || parsed.tipo_fixo === "duvida") {
      parsed.tipo_fixo = classificarFixoOuVariavel(text);
    }
    return parsed;
  } catch (err) {
    console.error("⚠️ Erro IA interpretação:", err);
    return { acao: "outros", valor: null, descricao: text, tipo_fixo: "duvida" };
  }
}

/* ============================================================
💰 REGISTRO DE TRANSAÇÃO
============================================================ */
async function registrarTransacao({ tipo, valor, descricao, tipo_fixo, categoria, chatId, userId, familyId }) {
  try {
    const transacao = {
      tipo,
      valor: Number(valor),
      descricao,
      tipo_fixo, // fixa ou variavel
      categoria: categoria || null,
      chat_id: chatId.toString(),
      user_id: userId,
      family_id: familyId || null,
    };

    const { error } = await supabase.from("transacoes").insert(transacao);

    if (error) {
      console.error("❌ Erro ao salvar:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar transação.");
    } else {
      await sendMessage(
        chatId,
        `✅ ${tipo.toUpperCase()} ${tipo_fixo.toUpperCase()} registrada!\n💰 Valor: R$${valor}\n📂 Categoria: ${categoria || "não definida"}`
      );
    }
  } catch (err) {
    console.error("💥 Erro crítico:", err);
    await sendMessage(chatId, "⚠️ Erro interno ao registrar transação.");
  }
}

/* ============================================================
📊 CONSULTAS
============================================================ */
async function responderConsulta(chatId, text, familyId, userId) {
  const filtro = familyId ? { family_id: familyId } : { user_id: userId };
  const { data } = await supabase.from("transacoes").select("*").match(filtro);

  const entradas = data?.filter((t) => t.tipo === "entrada").reduce((a, b) => a + Number(b.valor), 0) || 0;
  const saidas = data?.filter((t) => t.tipo === "saida").reduce((a, b) => a + Number(b.valor), 0) || 0;
  const saldo = entradas - saidas;

  if (/saldo|quanto/i.test(text)) {
    await sendMessage(chatId, `💰 Seu saldo atual é *R$${saldo.toFixed(2)}*`);
    return;
  }

  const resumo =
    data?.map(
      (t) =>
        `${t.tipo}: R$${t.valor} - ${t.descricao} (${t.categoria || "sem categoria"})`
    ).join("\n") || "Sem transações registradas.";

  const prompt = `
Você é um assistente financeiro.
Transações do usuário:
${resumo}

Pergunta: "${text}"
Responda em português de forma breve e útil.
`;

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  await sendMessage(chatId, `🤖 ${result.choices[0].message.content}`);
}

/* ============================================================
🏷️ ATUALIZAÇÃO DE CATEGORIA
============================================================ */
async function atualizarCategoria(chatId, text, userId) {
  const match = text.match(/categoria\s+([\w\s]+)\s+(\d+)/i);
  if (!match) {
    await sendMessage(chatId, "Use assim: `categoria mercado 123` (123 é o ID da transação)");
    return;
  }

  const categoria = match[1].trim();
  const id = Number(match[2]);

  const { error } = await supabase.from("transacoes").update({ categoria }).eq("id", id).eq("user_id", userId);

  if (error) {
    await sendMessage(chatId, "⚠️ Erro ao atualizar categoria.");
  } else {
    await sendMessage(chatId, `✅ Categoria atualizada para *${categoria}* na transação #${id}`);
  }
}

/* ============================================================
🤖 WEBHOOK TELEGRAM — CONVERSA INTELIGENTE
============================================================ */
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return res.sendStatus(200);

  console.log("💬 Mensagem recebida:", text);

  // Ativação
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

  // Categoria manual
  if (text.toLowerCase().startsWith("categoria")) {
    await atualizarCategoria(chatId, text, user_id);
    return res.sendStatus(200);
  }

  const interpret = await interpretarMensagem(text);
  console.log("🧠 Interpretação:", interpret);

  if (["entrada", "saida"].includes(interpret.acao) && interpret.valor) {
    // Se o tipo fixo for incerto, perguntar
    if (interpret.tipo_fixo === "duvida") {
      await sendMessage(chatId, `Essa ${interpret.acao} é *fixa* ou *variável*?`);
      return res.sendStatus(200);
    }

    // Registro direto
    await registrarTransacao({
      tipo: interpret.acao,
      valor: interpret.valor,
      descricao: interpret.descricao,
      tipo_fixo: interpret.tipo_fixo,
      chatId,
      userId: user_id,
      familyId: family_id,
    });
  } else if (interpret.acao === "consulta") {
    await responderConsulta(chatId, text, family_id, user_id);
  } else {
    await sendMessage(chatId, "💬 Não entendi. Você pode enviar algo como `+1200 salário` ou `-250 mercado`.");
  }

  res.sendStatus(200);
});

/* ============================================================
🌐 SERVER
============================================================ */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server online na porta ${port}`));
