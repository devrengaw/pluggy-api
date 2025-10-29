import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { PluggyClient } from 'pluggy-sdk'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

const pluggyClient = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
)

app.get('/', (req, res) => {
  res.send('API está rodando! 🔌')
})

app.get('/connect-token', async (req, res) => {
  try {
    const newUser = await pluggyClient.connect.createUser()
    const connectToken = await pluggyClient.connect.createConnectToken(newUser.id)

    await supabase.from('users').insert([{ pluggy_user_id: newUser.id }])

    res.json(connectToken)
  } catch (error) {
    console.error('Erro:', error)
    res.status(500).json({ error: error.message || error })
  }
})

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`)
})
