// index.js
import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import pluggyClient from "./pluggy.js"
import supabase from "./supabase.js"
import webhook from "./webhook.js" // 🆕 novo import

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

// ✅ Healthcheck
app.get("/", (req, res) => {
  res.send("✅ API FinanceFlow rodando com sucesso!")
})

// ✅ Endpoint de geração do Connect Token (para o front)
app.get("/connect-token", async (req, res) => {
  try {
    const response = await pluggyClient.connect.create({
      clientUserId: "user-" + Date.now().toString(),
    })
    res.json(response)
  } catch (error) {
    console.error("Erro ao gerar connect token:", error)
    res.status(500).json({ error: error.message })
  }
})

// ✅ Endpoint para listar conexões salvas no Supabase
app.get("/connections", async (req, res) => {
  try {
    const { data, error } = await supabase.from("bank_connections").select("*")
    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error("Erro ao buscar conexões:", error)
    res.status(500).json({ error: error.message })
  }
})

// ✅ Rota do webhook (Pluggy → Render)
app.use("/", webhook)

const port = process.env.PORT || 10000
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`)
})
