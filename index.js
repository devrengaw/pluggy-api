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

// Rota simples para teste
app.get('/', (req, res) => {
  res.send('Pluggy API está no ar 🔌');
});

// Rota para gerar token de conexão do Pluggy e salvar no Supabase
app.get('/connect-token', async (req, res) => {
  try {
    // 1. Cria um novo usuário no Pluggy
    const newUser = await pluggyClient.connect.createUser();

    console.log('Novo usuário Pluggy criado:', newUser);

    // 2. Cria um connect token para o usuário recém-criado
    const connectToken = await pluggyClient.connect.createConnectToken(newUser.id);

    // 3. Salva o pluggy_user_id no Supabase
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

    // 4. Retorna o token para o frontend
    res.json(connectToken);
  } catch (error) {
    console.error('Erro ao gerar connect token:', error);
    res.status(500).json({ error: error.message || error });
  }
});


// (Opcional) Rota para listar usuários (apenas para testes)
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
  console.log(`Servidor rodando na porta ${port}`);
});
