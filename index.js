import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

async function calcularSaldo(chatId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor")
    .eq("chat_id", chatId);
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
  const parts = text.split(" ");
  const valor = parts[1];
  const descricao = parts.slice(2).join(" ") || "Sem descrição";

  const { error } = await supabase.from("transacoes").insert({
    tipo: "entrada",
    valor,
    descricao,
    chat_id: chatId,
  });

  if (error) {
    console.error("❌ Erro ao salvar entrada:", error);
    await sendMessage(chatId, "⚠️ Erro ao salvar a entrada.");
  } else {
    await sendMessage(chatId, `✅ *Entrada registrada:*\nR$${valor} — ${descricao}`);
  }
}

async function comandoSaida(chatId, text) {
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
  const saldo = await calcularSaldo(chatId);
  if (saldo === null) await sendMessage(chatId, "⚠️ Erro ao buscar saldo.");
  else await sendMessage(chatId, `📊 *Seu saldo atual é:*\nR$${saldo}`);
}

async function comandoResumo(chatId) {
  const { data, error } = await supabase
    .from("transacoes")
    .select("tipo, valor, created_at")
    .eq("chat_id", chatId)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  if (error || !data || data.length === 0) {
    await sendMessage(chatId, "📭 Nenhuma transação nos últimos 7 dias.");
    return;
  }

  const totalEntrada = data
    .filter((t) => t.tipo === "entrada")
    .reduce((acc, t) => acc + Number(t.valor), 0);
  const totalSaida = data
    .filter((t) => t.tipo === "saida")
    .reduce((acc, t) => acc + Number(t.valor), 0);

  const saldo = totalEntrada - totalSaida;

  await sendMessage(
    chatId,
    `📅 *Resumo dos últimos 7 dias:*\n\n💰 Entradas: R$${totalEntrada.toFixed(
      2
    )}\n💸 Saídas: R$${totalSaida.toFixed(2)}\n📊 Saldo: R$${saldo.toFixed(2)}`
  );
}

async function comandoExtrato(chatId) {
  const mesAtual = new Date().toISOString().slice(0, 7);
  const { data, error } = await supabase
    .from("transacoes")
    .select("*")
    .eq("chat_id", chatId)
    .gte("created_at", `${mesAtual}-01`)
    .lte("created_at", `${mesAtual}-31`);

  if (error || !data || data.length === 0) {
    await sendMessage(chatId, "📭 Nenhuma transação neste mês.");
    return;
  }

  const lista = data
    .map((t) => {
      const dataFormatada = new Date(t.created_at).toLocaleDateString("pt-BR");
      const simbolo = t.tipo === "entrada" ? "💰" : "💸";
      return `${simbolo} ${dataFormatada} — R$${t.valor} (${t.descricao})`;
    })
    .join("\n");

  const totalEntradas = data
    .filter((t) => t.tipo === "entrada")
    .reduce((acc, t) => acc + Number(t.valor), 0);
  const totalSaidas = data
    .filter((t) => t.tipo === "saida")
    .reduce((acc, t) => acc + Number(t.valor), 0);
  const saldo = totalEntradas - totalSaidas;

  await sendMessage(
    chatId,
    `📆 *Extrato do mês atual:*\n\n${lista}\n\n💰 Total Entradas: R$${totalEntradas.toFixed(
      2
    )}\n💸 Total Saídas: R$${totalSaidas.toFixed(2)}\n📊 Saldo: R$${saldo.toFixed(2)}`
  );
}

// ============================================================
// 🗂️ CATEGORIAS, METAS, CARTÕES E ALERTAS
// ============================================================
async function comandoCategorias(chatId, text) {
  const partes = text.split(" ");
  const acao = partes[1];
  const nome = partes.slice(2).join(" ");

  if (acao === "adicionar") {
    const { error } = await supabase.from("categorias").insert({
      chat_id: chatId,
      nome,
    });
    if (error) await sendMessage(chatId, "⚠️ Erro ao adicionar categoria.");
    else await sendMessage(chatId, `✅ Categoria adicionada: *${nome}*`);
  } else if (acao === "listar") {
    const { data } = await supabase.from("categorias").select("nome").eq("chat_id", chatId);
    if (!data || data.length === 0) {
      await sendMessage(chatId, "📭 Nenhuma categoria cadastrada.");
      return;
    }
    const lista = data.map((c) => `• ${c.nome}`).join("\n");
    await sendMessage(chatId, `🗂️ *Suas categorias:*\n${lista}`);
  } else if (acao === "remover") {
    await supabase.from("categorias").delete().eq("chat_id", chatId).eq("nome", nome);
    await sendMessage(chatId, `🗑️ Categoria removida: *${nome}*`);
  } else {
    await sendMessage(chatId, "🗂️ Use:\n/categoria adicionar [nome]\n/categoria listar\n/categoria remover [nome]");
  }
}

async function comandoMetas(chatId, text) {
  const partes = text.split(" ");
  const acao = partes[1];
  const categoria = partes[2];
  const valor = partes[3];

  if (acao === "definir") {
    const { error } = await supabase.from("metas").insert({
      chat_id: chatId,
      categoria,
      valor,
    });
    if (error) await sendMessage(chatId, "⚠️ Erro ao definir meta.");
    else await sendMessage(chatId, `🎯 Meta definida: *${categoria}* — R$${valor}`);
  } else if (acao === "listar") {
    const { data } = await supabase.from("metas").select("categoria, valor").eq("chat_id", chatId);
    if (!data || data.length === 0) {
      await sendMessage(chatId, "📭 Nenhuma meta definida.");
      return;
    }
    const lista = data.map((m) => `• ${m.categoria}: R$${m.valor}`).join("\n");
    await sendMessage(chatId, `🎯 *Suas metas:*\n${lista}`);
  } else {
    await sendMessage(chatId, "🎯 Use:\n/meta definir [categoria] [valor]\n/meta listar");
  }
}

async function comandoCartoes(chatId, text) {
  const partes = text.split(" ");
  const acao = partes[1];
  const nome = partes[2];
  const fechamento = partes[3];

  if (acao === "adicionar") {
    const { error } = await supabase.from("cartoes").insert({
      chat_id: chatId,
      nome,
      fechamento,
    });
    if (error) await sendMessage(chatId, "⚠️ Erro ao adicionar cartão.");
    else await sendMessage(chatId, `💳 Cartão adicionado: *${nome}* (fechamento dia ${fechamento})`);
  } else if (acao === "listar") {
    const { data } = await supabase.from("cartoes").select("nome, fechamento").eq("chat_id", chatId);
    if (!data || data.length === 0) {
      await sendMessage(chatId, "📭 Nenhum cartão cadastrado.");
      return;
    }
    const lista = data.map((c) => `• ${c.nome} — fecha dia ${c.fechamento}`).join("\n");
    await sendMessage(chatId, `💳 *Seus cartões:*\n${lista}`);
  } else {
    await sendMessage(chatId, "💳 Use:\n/cartao adicionar [nome] [dia]\n/cartao listar");
  }
}

async function comandoAlertas(chatId, text) {
  const acao = text.split(" ")[1];
  if (acao === "ativar") {
    await supabase.from("alertas").upsert({ chat_id: chatId, ativo: true });
    await sendMessage(chatId, "🔔 Alertas automáticos ativados.");
  } else if (acao === "desativar") {
    await supabase.from("alertas").upsert({ chat_id: chatId, ativo: false });
    await sendMessage(chatId, "🔕 Alertas automáticos desativados.");
  } else {
    await sendMessage(chatId, "🔔 Use:\n/alerta ativar\n/alerta desativar");
  }
}

// ============================================================
// 🤖 ROTEAMENTO DO TELEGRAM
// ============================================================
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);
  const chatId = message.chat.id;
  const text = message.text?.trim().toLowerCase() || "";

  try {
    if (text.startsWith("/entrada")) await comandoEntrada(chatId, text);
    else if (text.startsWith("/saida")) await comandoSaida(chatId, text);
    else if (text === "/saldo") await comandoSaldo(chatId);
    else if (text === "/resumo") await comandoResumo(chatId);
    else if (text === "/extrato") await comandoExtrato(chatId);
    else if (text.startsWith("/categoria")) await comandoCategorias(chatId, text);
    else if (text.startsWith("/meta")) await comandoMetas(chatId, text);
    else if (text.startsWith("/cartao")) await comandoCartoes(chatId, text);
    else if (text.startsWith("/alerta")) await comandoAlertas(chatId, text);
    else await sendMessage(chatId, "👋 Use /ajuda para ver os comandos disponíveis.");
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
