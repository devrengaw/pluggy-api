// index.js
import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import pluggyClient from "./pluggy.js"
import supabase from "./supabase.js"

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

// Healthcheck simples
app.get("/", (req, res) => {
  res.json({ status: "ok" })
})

// ✅ Endpoint que realmente gerou o token Pluggy com sucesso
app.get("/connect-token", async (req, res) => {
  try {
    const connectToken = await pluggyClient.connect.create({
      clientUserId: "user-" + Date.now().toString(),
    })
    res.json(connectToken)
  } catch (error) {
    console.error("Erro ao gerar connect token:", error)
    res.status(500).json({ error: error.message })
  }
})

// ✅ (opcional) Endpoint para listar conexões (caso precise)
app.get('/connect-token', async (req, res) => {
  // ...
  const connectToken = await pluggyClient.connect.createConnectToken(newUser.id);
  res.json(connectToken);
});

// Porta do Render
const port = process.env.PORT || 10000
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`)
})
