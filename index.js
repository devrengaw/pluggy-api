// === TELEGRAM ===
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  console.log("🔔 Mensagem recebida do Telegram:", req.body);
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text?.toLowerCase() || "";

  // Função auxiliar para enviar mensagem de volta
  async function sendMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  // --- ENTRADA ---
  if (text.startsWith("/entrada")) {
    const valor = text.split(" ")[1];
    const descricao = text.split(" ").slice(2).join(" ") || "Sem descrição";

    const { error } = await supabase.from("transactions").insert({
      tipo: "entrada",
      valor,
      descricao,
      chat_id: chatId,
    });

    if (error) {
      console.error("❌ Erro ao salvar entrada:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar a entrada no banco de dados.");
    } else {
      console.log("✅ Entrada salva no Supabase");
      await sendMessage(chatId, `✅ Entrada registrada: R$${valor} (${descricao})`);
    }

    return res.sendStatus(200);
  }

  // --- SAÍDA ---
  if (text.startsWith("/saida")) {
    const valor = text.split(" ")[1];
    const descricao = text.split(" ").slice(2).join(" ") || "Sem descrição";

    const { error } = await supabase.from("transacoes").insert({
      tipo: "saida",
      valor,
      descricao,
      chat_id: chatId,
    });

    if (error) {
      console.error("❌ Erro ao salvar saída:", error);
      await sendMessage(chatId, "⚠️ Erro ao salvar a saída no banco de dados.");
    } else {
      console.log("✅ Saída salva no Supabase");
      await sendMessage(chatId, `💸 Saída registrada: R$${valor} (${descricao})`);
    }

    return res.sendStatus(200);
  }

  // --- SALDO ---
  if (text === "/saldo") {
    const { data, error } = await supabase
      .from("transactions")
      .select("tipo, valor")
      .eq("chat_id", chatId);

    if (error || !data) {
      console.error("❌ Erro ao buscar saldo:", error);
      await sendMessage(chatId, "⚠️ Erro ao buscar saldo.");
      return res.sendStatus(200);
    }

    if (data.length === 0) {
      await sendMessage(chatId, "📭 Nenhuma transação encontrada ainda.");
      return res.sendStatus(200);
    }

    const saldo = data.reduce((acc, item) => {
      return acc + (item.tipo === "entrada" ? Number(item.valor) : -Number(item.valor));
    }, 0);

    await sendMessage(chatId, `📊 Seu saldo atual é: R$${saldo.toFixed(2)}`);
    return res.sendStatus(200);
  }

  // --- AJUDA ---
  await sendMessage(
    chatId,
    "👋 Comandos disponíveis:\n\n/entrada 100 descricao\n/saida 50 descricao\n/saldo"
  );
  res.sendStatus(200);
});
