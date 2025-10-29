import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PluggyClient } from 'pluggy-sdk'; // <-- Correto para versão 0.78.1
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicializa Pluggy corretamente
const pluggyClient = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET
});

// Inicializa Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Rota teste
app.get('/', (req, res) => {
  res.send('🔌 API Pluggy + Supabase está ativa!');
});

// Rota para gerar token do Pluggy e salvar no Supabase
app.get('/connect-token', async (req, res) => {
  try {
    const newUser = await pluggyClient.createUser(); // <-- CORRETO com v0.78.1
    console.log('Usuário criado:', newUser);

    const connectToken = await pluggyClient.createConnectToken(newUser.id);
    console.log('Token gerado:', connectToken);

    const { data, error } = await supabase
      .from('users')
      .insert([{ pluggy_user_id: newUser.id }]);

    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
    } else {
      console.log('Usuário salvo no Supabase:', data);
    }

    res.json(connectToken);
  } catch (error) {
    console.error('Erro ao gerar connect token:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// Lista usuários
app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');

  if (error) {
    res.status(500).json({ error });
  } else {
    res.json(data);
  }
});

app.listen(port, () => {
  console.log(`✅ Servidor rodando na porta ${port}`);
});
