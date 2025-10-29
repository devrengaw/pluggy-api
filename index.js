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

// ✅ Health check (Render usa pra saber se o servidor está vivo)
app.get("/", (req, res) => {
  res.json({ status: "ok" })
})

// ✅ Geração do token Pluggy
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

// ✅ Listar conexões (mock / exemplo — pode puxar do Supabase)
app.get("/connections", async (req, res) => {
  try {
    const { data, error } = await supabase.from("connections").select("*")
    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error("Erro ao buscar conexões:", error)
    res.status(500).json({ error: error.message })
  }
})

// ✅ Porta Render
const port = process.env.PORT || 10000
app.listen(port, () => {
  console.log(`✅ Server online na porta ${port}`)
})
