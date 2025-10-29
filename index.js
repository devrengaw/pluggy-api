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

// Inicializa Pluggy com os dados do .env
const pluggyClient = new Pluggy.Client({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET
});

// Inicializa Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Rota para verificar se está funcionando
app.get('/', (req, res) => {
  res.send('Pluggy API está rodando 🔌');
});

// Rota para criar usuário e gerar token
app.get('/connect-token', async (req, res) => {
  try {
    // Cria novo usuário Pluggy
    const newUser = await pluggyClient.users.create();

    console.log('Usuário criado:', newUser);

    // Gera connect token
    const tokenResponse = await pluggyClient.connect.createToken(newUser.id);

    // Salva no Supabase
    const { data, error } = await supabase
      .from('users')
      .insert([{ pluggy_user_id: newUser.id }]);

    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
    } else {
      console.log('Usuário salvo:', data);
    }

    res.json(tokenResponse); // Retorna token pro frontend

  } catch (error) {
    console.error('Erro ao gerar connect token:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
