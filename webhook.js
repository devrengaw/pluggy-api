// webhook.js
import express from "express"
import supabase from "./supabase.js"

const router = express.Router()

router.post("/webhook", express.json(), async (req, res) => {
  const event = req.body
  console.log("📩 Evento recebido da Pluggy:", event.type)

  try {
    if (event.type === "ITEM.CREATED" || event.type === "ITEM.UPDATED") {
      const item = event.data

      await supabase.from("bank_connections").upsert({
        pluggy_item_id: item.id,
        institution: item.institution.name,
        status: item.status,
        last_updated: new Date(),
      })

      console.log("✅ Conexão salva/atualizada no Supabase:", item.institution.name)
    }

    if (event.type === "TRANSACTION.CREATED") {
      console.log("📊 Novas transações disponíveis:", event.data.length)
      // (Etapa 2 futura: salvar transações automaticamente)
    }

    res.sendStatus(200)
  } catch (err) {
    console.error("❌ Erro ao processar webhook:", err)
    res.sendStatus(500)
  }
})

export default router
