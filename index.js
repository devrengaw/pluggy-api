import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PluggyClient } from 'pluggy-sdk';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Pluggy setup
const pluggyClient = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET
});

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Test route
app.get('/', (req, res) => {
  res.send('Pluggy API está no ar 🔌');
});

// Rota para gerar link de conexão com instituição bancária
app.get('/connect-token', async (req, res) => {
  try {
    const connectToken = await pluggyClient.createConnectToken();
    res.json(connectToken);
  } catch (error) {
    console.error('Erro ao gerar connect token:', error);
    res.status(500).json({ error: 'Erro ao gerar token de conexão' });
  }
});

// Exemplo de rota Supabase (pode ser ajustada depois)
app.get('/usuarios', async (req, res) => {
  const { data, error } = await supabase.from('usuarios').select('*');
  if (error) {
    res.status(500).json({ error });
  } else {
    res.json(data);
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
