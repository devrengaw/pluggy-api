import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Pluggy from 'pluggy-sdk';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicializa Pluggy
const pluggyClient = new Pluggy.PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET
});

// Inicializa Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Rota básica para testar se o servidor está online
app.get('/', (req, res) => {
  res.send('🔌 API Pluggy + Supabase rodando com sucesso!');
});

// Rota para gerar token do Pluggy e salvar usuário no Supabase
app.get('/connect-token', async (req, res) => {
  try {
    // Cria usuário no Pluggy
    const newUser = await pluggyClient.connect.createUser();
    console.log('Novo usuário Pluggy criado:', newUser);

    // Cria token de conexão Pluggy
    const connectToken = await pluggyClient.connect.createConnectToken(newUser.id);

    // Salva o usuário no Supabase
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          pluggy_user_id: newUser.id
        }
      ]);

    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
    } else {
      console.log('Usuário salvo no Supabase:', data);
    }

    // Retorna o token de conexão
    res.json(connectToken);
  } catch (error) {
    console.error('Erro ao gerar connect token:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// Rota para listar todos os usuários da tabela "users"
app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');

  if (error) {
    res.status(500).json({ error });
  } else {
    res.json(data);
  }
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`✅ Servidor rodando na porta ${port}`);
});
