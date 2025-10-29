// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pluggyClient from "./pluggy.js";
import supabase from "./supabase.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🩺 Healthcheck
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Servidor rodando corretamente 🚀" });
});

// 🔑 Gera o connect token do Pluggy (usado pelo front para abrir o modal de conexão)
app.get("/connect-token", async (req, res) => {
  try {
    const connectToken = await pluggyClient.connectTokens.create();
    res.json(connectToken);
  } catch (error) {
    console.error("Erro ao gerar connect token:", error);
    res.status(500).json({ error: error.message });
  }
});

// 💡 Exemplo de integração futura com Supabase (quando você salvar conexões ou usuários)
app.get("/users", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*");
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// 🚀 Inicializa o servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`);
});
